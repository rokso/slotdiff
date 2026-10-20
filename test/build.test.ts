/**
 * `analyzeBuild` on output the caller already compiled, as a build tool hands
 * it over: the same analysis as `analyzeSource`, one namespaced pass for every
 * contract, and a refusal for output that is incomplete or from another build.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SolcInput, SolcOutput } from "@openzeppelin/upgrades-core";
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
// From the public entry point: build tools call it directly.
import { analyzeBuild, analyzeSource, type BuildCompiler } from "../src/index.js";
import { IncompleteBuildError, LayoutIntegrityError } from "../src/index.js";
import { getSolc, type SolcRunner } from "../src/solc.js";

const header = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n";
const LOCATION = calculateERC7201StorageLocation("x.main");
const BOX = "project/contracts/Box.sol:Box";
// Hardhat 3 keys sources as project/...
const SOURCES: Record<string, string> = {
  "project/contracts/Box.sol": `${header}import {IBox, Lib} from "./Kinds.sol";
contract Box is IBox {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    uint256 public version;
    function _s() private pure returns (S storage $) { assembly { $.slot := ${LOCATION} } }
    function a() external view returns (uint256) { return Lib.id(_s().a); }
    function upgradeToAndCall(address, bytes calldata) external payable {}
}\n`,
  "project/contracts/Kinds.sol": `${header}interface IBox { function a() external view returns (uint256); }
library Lib { function id(uint256 x) internal pure returns (uint256) { return x; } }\n`,
  "project/contracts/Bad.sol": `${header}contract Bad { uint256 b; constructor() { b = 1; } }\n`,
};
// What a build tool asks solc for when the build is to be checked.
const SELECTION = {
  "*": {
    "*": ["metadata", "storageLayout", "evm.bytecode.object", "evm.bytecode.linkReferences"],
    "": ["ast"],
  },
};

let solc: SolcRunner;
let input: SolcInput;
let output: SolcOutput;

function inputOf(sources: Record<string, string>): SolcInput {
  return {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { outputSelection: SELECTION },
  } as SolcInput;
}

beforeAll(async () => {
  solc = await getSolc("0.8.24+commit.e11b9ed9");
  input = inputOf(SOURCES);
  output = await solc.compile(input);
}, 120_000);

// Counts the namespaced passes the analysis runs through the build tool's compiler.
function counting(longVersion = solc.longVersion): BuildCompiler & { calls: number } {
  const c = {
    calls: 0,
    longVersion,
    compile: (i: SolcInput) => {
      c.calls++;
      return solc.compile(i);
    },
  };
  return c;
}

// `output` with `change` applied to every contract named in `names`.
function editContracts(names: string[], change: (c: Record<string, unknown>) => object) {
  const contracts = Object.fromEntries(
    Object.entries(output.contracts).map(([path, byName]) => [
      path,
      Object.fromEntries(
        Object.entries(byName).map(([n, c]) => [n, names.includes(n) ? change(c) : c]),
      ),
    ]),
  );
  return { ...output, contracts } as unknown as SolcOutput;
}

describe("analyzeBuild", () => {
  it("analyzes every contract like analyzeSource, from one namespaced pass", async () => {
    const compiler = counting();
    const build = await analyzeBuild(input, output, compiler);
    for (const contract of [BOX, "project/contracts/Bad.sol:Bad"]) {
      const reused = build.contract(contract);
      const fresh = await analyzeSource(input, solc, contract);
      expect(reused.layout).toEqual(fresh.layout);
      expect([reused.kind, reused.namespaces]).toEqual([fresh.kind, fresh.namespaces]);
      const kinds = (a: typeof reused) => a.safety({ kind: "uups" }).errors.map((e) => e.kind);
      expect(kinds(reused)).toEqual(kinds(fresh));
    }
    expect(compiler.calls).toBe(1);
    const box = build.contract(BOX);
    expect([box.kind, box.namespaces[0].status]).toEqual(["uups", "match"]);
  }, 120_000);

  it("gives each caller its own layout to change", async () => {
    const build = await analyzeBuild(input, output, counting());
    const first = build.contract(BOX);
    first.layout.storage[0].renamedFrom = "tagged";
    expect(build.contract(BOX).layout.storage[0].renamedFrom).toBeUndefined();
  }, 60_000);

  // Foundry leaves the layout of contracts that cannot hold state out of its build info.
  it("accepts an interface and a library without a storageLayout", async () => {
    const foundry = editContracts(["IBox", "Lib"], (c) => ({ ...c, storageLayout: undefined }));
    const build = await analyzeBuild(input, foundry, counting());
    expect(build.contract(BOX).layout.storage.map((s) => s.label)).toEqual(["version"]);
  }, 60_000);

  // Without the AST no slot assignment is found, so every namespace would read as unused.
  it("refuses output without an ast, which would pass every namespace by annotation", async () => {
    const sources = Object.fromEntries(
      Object.entries(output.sources).map(([k, v]) => [k, { ...v, ast: undefined }]),
    );
    const stripped = { ...output, sources } as unknown as SolcOutput;
    const err = await analyzeBuild(input, stripped, counting()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteBuildError);
    expect((err as Error).message).toContain(
      "The compiler output has no ast for project/contracts/Box.sol",
    );
  });

  it.each([
    ["metadata", (c: Record<string, unknown>) => ({ ...c, metadata: undefined })],
    [
      "a storageLayout for a contract",
      (c: Record<string, unknown>) => ({ ...c, storageLayout: undefined }),
    ],
    [
      "bytecode",
      (c: Record<string, unknown>) => ({
        ...c,
        evm: { bytecode: { object: 1, linkReferences: {} } },
      }),
    ],
    [
      "linkReferences",
      (c: Record<string, unknown>) => ({ ...c, evm: { bytecode: { object: "" } } }),
    ],
  ])("refuses output without %s", async (_, change) => {
    const err = await analyzeBuild(input, editContracts(["Box"], change), counting()).catch(
      (e: unknown) => e,
    );
    // Its own class, so a build tool can tell its users to compile again.
    expect(err).toBeInstanceOf(IncompleteBuildError);
    expect((err as Error).message).toContain(
      `The compiler output for ${BOX} lacks metadata, storageLayout or evm.bytecode`,
    );
  });

  it("refuses metadata that does not list the contract's own source", async () => {
    const bare = editContracts(["Box"], (c) => {
      const metadata = JSON.parse(c.metadata as string);
      return { ...c, metadata: JSON.stringify({ ...metadata, sources: {} }) };
    });
    const err = await analyzeBuild(input, bare, counting()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toContain("(project/contracts/Box.sol differs)");
  });

  it("names the wrapped output of a Hardhat 3 build info file", async () => {
    const wrapped = { _format: "hh3-sol-build-info-output-1", output } as unknown as SolcOutput;
    await expect(analyzeBuild(input, wrapped, counting())).rejects.toThrow("pass its output field");
  });

  // The reviewer's case: a same-length edit left the old layout in place, unnoticed.
  it("refuses output compiled from other sources, even when the edit keeps every offset", async () => {
    const edited = inputOf({
      ...SOURCES,
      "project/contracts/Box.sol": SOURCES["project/contracts/Box.sol"].replace(
        "uint256 public version;",
        "int256  public version;",
      ),
    });
    const err = await analyzeBuild(edited, output, counting()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toBe(
      `The compiler output for ${BOX} was not compiled from this input (project/contracts/Box.sol differs).`,
    );
  });

  it.each(["0.8.25+commit.b61c2a91", "0.8.25", "0.8.24+commit.00000000"])(
    "refuses output from another compiler (%s)",
    async (longVersion) => {
      const err = await analyzeBuild(input, output, counting(longVersion)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LayoutIntegrityError);
      expect((err as Error).message).toContain("was compiled by solc 0.8.24+commit.e11b9ed9");
    },
  );

  it("accepts a compiler named by its release alone", async () => {
    await expect(analyzeBuild(input, output, counting("0.8.24"))).resolves.toBeDefined();
  }, 60_000);

  it("refuses output that does not hold the same sources as the input", async () => {
    const extra = {
      ...output,
      sources: { ...output.sources, "project/contracts/Extra.sol": { id: 99, ast: {} } },
    } as unknown as SolcOutput;
    await expect(analyzeBuild(input, extra, counting())).rejects.toThrow(
      "The compiler output does not hold the same sources as the input.",
    );
  });

  it("refuses output that leaves out a contract of its sources", async () => {
    const contracts = { ...output.contracts };
    delete contracts["project/contracts/Kinds.sol"];
    const partial = { ...output, contracts } as unknown as SolcOutput;
    await expect(analyzeBuild(input, partial, counting())).rejects.toThrow(
      new IncompleteBuildError(
        "The compiler output has no contract output for project/contracts/Kinds.sol:IBox.",
      ),
    );
  });

  it("names a contract the build does not have", async () => {
    const build = await analyzeBuild(input, output, counting());
    expect(() => build.contract("contracts/Box.sol:Box")).toThrow("is not in the compiler input");
  }, 60_000);
});
