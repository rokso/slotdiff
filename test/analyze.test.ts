/**
 * `analyzeSource` with a real solc: the safety check must judge the contract
 * asked for, and infer its proxy kind through inheritance.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { UpgradeableContractErrorReport, type SolcInput } from "@openzeppelin/upgrades-core";
// From the public entry point: library users get the same check as the CLI.
import { analyzeSource, type SafetyErrorKind } from "../src/index.js";
import { getSolc, type SolcRunner } from "../src/solc.js";
import { LayoutIntegrityError } from "../src/errors.js";

const SOLC = "0.8.24+commit.e11b9ed9";
const header = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n";

function input(sources: Record<string, string>, settings: object = {}): SolcInput {
  return {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { optimizer: { enabled: false, runs: 200 }, ...settings },
  } as SolcInput;
}

let solc: SolcRunner;

beforeAll(async () => {
  solc = await getSolc(SOLC);
}, 120_000);

describe("analyzeSource", () => {
  // Without CBOR metadata both compile to identical bytecode, and OZ looks
  // contracts up by bytecode, taking the first match. Each file order puts the
  // other contract first at least once.
  it.each([
    ["src/A.sol", "src/B.sol"],
    ["src/B.sol", "src/A.sol"],
  ])(
    "judges the contract asked for when another has identical code (%s first)",
    async (...order) => {
      const files: Record<string, string> = {
        "src/A.sol": `${header}contract Allowed { uint256 a;
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { a = 1; } }\n`,
        "src/B.sol": `${header}contract Bad { uint256 a; constructor() { a = 1; } }\n`,
      };
      const sources = Object.fromEntries(order.map((k) => [k, files[k]]));
      const noCbor = { metadata: { appendCBOR: false } };
      const allowed = await analyzeSource(input(sources, noCbor), solc, "src/A.sol:Allowed");
      const bad = await analyzeSource(input(sources, noCbor), solc, "src/B.sol:Bad");
      expect(allowed.safety({ kind: "transparent" }).ok).toBe(true);
      expect(bad.safety({ kind: "transparent" }).ok).toBe(false);
    },
    60_000,
  );

  it("infers UUPS through a base contract, and finds unsafe code in a base", async () => {
    const sources = {
      "src/Base.sol": `${header}abstract contract Base {
    function upgradeToAndCall(address, bytes calldata) external payable {}
    function call(address t) external { (bool ok, ) = t.delegatecall(""); ok; } }\n`,
      "src/Impl.sol": `${header}import {Base} from "./Base.sol";\ncontract Impl is Base { uint256 a; }\n`,
    };
    const analysis = await analyzeSource(input(sources), solc, "src/Impl.sol:Impl");
    expect(analysis.kind).toBe("uups");
    const safety = analysis.safety({ kind: analysis.kind });
    expect(safety.ok).toBe(false);
    expect(safety.errors.map((e) => e.kind)).toEqual(["delegatecall"]);
    expect(safety.errors[0].src).toMatch(/^src\/Base.sol:\d+$/);
    expect(safety.explain()).toContain("delegatecall");
    expect(analysis.safety({ kind: "uups", unsafeAllow: ["delegatecall"] }).ok).toBe(true);
    // OpenZeppelin appends to the list it gets (for external-library-linking); not to the caller's.
    const allow: SafetyErrorKind[] = ["external-library-linking"];
    analysis.safety({ kind: "uups", unsafeAllow: allow });
    expect(allow).toEqual(["external-library-linking"]);
  }, 60_000);

  it("passes explain's color choice on to OpenZeppelin", async () => {
    const sources = {
      "src/C.sol": `${header}contract C { uint256 a; constructor() { a = 1; } }\n`,
    };
    const safety = (await analyzeSource(input(sources), solc, "src/C.sol:C")).safety({
      kind: "transparent",
    });
    const spy = vi.spyOn(UpgradeableContractErrorReport.prototype, "explain");
    safety.explain(false);
    expect(spy).toHaveBeenCalledWith(false);
    spy.mockRestore();
  }, 60_000);

  it.each([
    ["a contract name the input lacks", "src/C.sol:Missing"],
    ["a source path the input names otherwise", "contracts/C.sol:C"],
  ])(
    "names the problem for %s",
    async (_, contract) => {
      const sources = { "src/C.sol": `${header}contract C { uint256 a; }\n` };
      await expect(analyzeSource(input(sources), solc, contract)).rejects.toThrow(
        `${contract} is not in the compiler input`,
      );
    },
    60_000,
  );

  it("still calls out an abstract contract as such", async () => {
    const sources = { "src/C.sol": `${header}abstract contract C { uint256 a; }\n` };
    const err = await analyzeSource(input(sources), solc, "src/C.sol:C").catch((e: unknown) => e);
    // An integrity error: no layout can be trusted for it, so callers never fall back.
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/compiled to no bytecode/);
  }, 60_000);

  it.each(["bogus", "struct-definition"])(
    "refuses an unsafeAllow kind it does not know (%s), which would accept nothing",
    async (kind) => {
      const sources = { "src/C.sol": `${header}contract C { uint256 a; }\n` };
      const analysis = await analyzeSource(input(sources), solc, "src/C.sol:C");
      expect(() =>
        analysis.safety({ kind: "transparent", unsafeAllow: [kind as SafetyErrorKind] }),
      ).toThrow(`Unknown unsafeAllow error kind "${kind}"`);
    },
    60_000,
  );
});
