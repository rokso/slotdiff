/**
 * End to end with a real solc: a mock chain runs compiled code (immutables
 * filled in, as on a real chain), a stubbed explorer serves the verified
 * standard-json, and the full pipeline must prove and extract the layout,
 * survive a JSON round trip, and then diff upgrades against it.
 *
 * Nothing in the pipeline is mocked except the two network endpoints.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
import type { SolcInput } from "@openzeppelin/upgrades-core";

import { resolveProxyLayout } from "../src/resolve.js";
import { verifyRecord } from "../src/record.js";
import { getSolc, type SolcRunner } from "../src/solc.js";
import { analyzeSource } from "../src/reconstruct.js";
import { LayoutIntegrityError } from "../src/errors.js";
import { diffLayouts } from "../src/diff.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const SOLC = "0.8.24+commit.e11b9ed9";
const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";

function source(structBody: string, extraVar = ""): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract Box {
    /// @custom:storage-location erc7201:box.main
    struct MainStorage {
${structBody}
    }

    address private immutable self = address(this);
    uint256 public version;
${extraVar}
    function getSelf() external view returns (address) {
        return self;
    }
}
`;
}

const V1 = source("        uint256 value;\n        address owner;\n        bool active;");
const V2_APPEND = source(
  "        uint256 value;\n        address owner;\n        bool active;\n        uint256 added;",
  "    uint256 public extra;",
);
const V2_INSERT = source(
  "        uint256 inserted;\n        uint256 value;\n        address owner;\n        bool active;",
);
const V2_RETYPE = source("        uint128 value;\n        address owner;\n        bool active;");

function input(content: string): SolcInput {
  return {
    language: "Solidity",
    sources: { "contracts/Box.sol": { content } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi"] } },
    },
  } as SolcInput;
}

let solc: SolcRunner;

// Deployed runtime code of `content`, immutables filled the way a constructor would.
async function deployedCode(content: string): Promise<string> {
  const out = await solc.compile({
    ...input(content),
    settings: {
      ...input(content).settings,
      outputSelection: {
        "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] },
      },
    },
  } as SolcInput);
  const deployed = (
    out.contracts["contracts/Box.sol"].Box as unknown as {
      evm: {
        deployedBytecode: {
          object: string;
          immutableReferences: Record<string, Array<{ start: number; length: number }>>;
        };
      };
    }
  ).evm.deployedBytecode;
  const buf = Buffer.from(deployed.object, "hex");
  const spans = Object.values(deployed.immutableReferences).flat();
  expect(spans.length).toBeGreaterThan(0); // the test is meaningless without one
  for (const { start, length } of spans) {
    Buffer.from(IMPL.slice(2).padStart(length * 2, "0"), "hex").copy(buf, start);
  }
  return "0x" + buf.toString("hex");
}

function explorerServing(served: string | SolcInput) {
  const verified = typeof served === "string" ? input(served) : served;
  const sourceCode = `{${JSON.stringify(verified)}}`;
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: "1",
      result: [{ SourceCode: sourceCode, ContractName: "Box", CompilerVersion: `v${SOLC}` }],
    }),
  }));
}

// The "new" side: the same extraction pipeline, applied to the local source.
async function localLayout(content: string) {
  return (await analyzeSource(input(content), solc, "contracts/Box.sol:Box")).layout;
}

beforeAll(async () => {
  // Uses a cached compiler when present (ours or Hardhat's), else downloads it.
  solc = await getSolc(SOLC);
}, 120_000);

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function chainRunning(running: string) {
  return makeMockChain({
    code: { [IMPL]: await deployedCode(running) },
    implementations: { [PROXY]: IMPL },
  });
}

async function chainBaselineFor(served: string | SolcInput, running: string) {
  vi.stubGlobal("fetch", explorerServing(served));
  return resolveProxyLayout(await chainRunning(running), PROXY, { explorer: { apiKey: "KEY" } });
}

describe("resolveProxyLayout end to end", () => {
  it("proves and extracts the layout of the running implementation", async () => {
    const first = await chainBaselineFor(V1, V1);

    expect(first.record.source).toBe("explorer");
    expect(first.implementation).toBe(IMPL);
    expect(first.record.bytecodeMatch).toBe("immutables-only");
    expect(first.record.contract).toBe("contracts/Box.sol:Box");
    expect(first.record.layout.storage.map((s) => s.label)).toEqual(["version"]);
    const ns = first.record.layout.namespaces?.["erc7201:box.main"];
    expect(ns?.map((i) => `${i.label}@${i.slot}/${i.offset}`)).toEqual([
      "value@0/0",
      "owner@1/0",
      "active@1/20", // packed: the namespaced pass supplies real offsets
    ]);
    // The rest of the analysis travels with the record, for a later checkUpgrade.
    expect(first.record.kind).toBe("transparent");
    expect(first.kind).toBe("transparent");
    expect(first.record.namespaces).toEqual([
      {
        namespace: "erc7201:box.main",
        expected: calculateERC7201StorageLocation("box.main"),
        status: "unused", // Box never assigns the slot
      },
    ]);
  }, 120_000);

  it("gives a beacon proxy the beacon kind, whatever its implementation implies", async () => {
    vi.stubGlobal("fetch", explorerServing(V1));
    const BEACON = "0x00000000000000000000000000000000000000cc";
    const provider = makeMockChain({
      code: { [IMPL]: await deployedCode(V1) },
      beacons: { [PROXY]: BEACON },
      beaconImplementations: { [BEACON]: IMPL },
    });
    const layout = await resolveProxyLayout(provider, PROXY, { explorer: { apiKey: "KEY" } });
    expect([layout.beacon, layout.kind, layout.record.kind]).toEqual([
      BEACON,
      "beacon",
      "transparent",
    ]);
  }, 120_000);

  it("gives a record that survives a JSON round trip and verifies without the explorer", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const saved = JSON.stringify(record);

    vi.stubGlobal("fetch", vi.fn());
    const loaded = await verifyRecord(await chainRunning(V1), IMPL, JSON.parse(saved));
    expect(loaded).toEqual(record);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(diffLayouts(loaded.layout, await localLayout(V1)).ok).toBe(true);
  }, 120_000);

  it("refuses a metadata-only match, which can hide a different layout", async () => {
    // Box never reads its namespaced struct, so inserting a field changes the
    // layout but not the code: only the metadata hash differs.
    const err = await chainBaselineFor(V2_INSERT, V1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/only after stripping metadata/);
  }, 120_000);

  it("picks the strongest match among same-named contracts", async () => {
    // A decoy Box in an earlier file matches only after stripping metadata.
    const served = input(V1);
    served.sources = {
      "contracts/A.sol": { content: V1 + "\n// decoy\n" },
      "contracts/Box.sol": { content: V1 },
    };
    const { record } = await chainBaselineFor(served, V1);
    expect(record.contract).toBe("contracts/Box.sol:Box");
    expect(record.bytecodeMatch).toBe("immutables-only");
  }, 120_000);

  it("refuses verified source that does not compile to the deployed code", async () => {
    await expect(chainBaselineFor(V2_APPEND, V1)).rejects.toThrow(LayoutIntegrityError);
  }, 120_000);

  it("passes an append-only upgrade", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = diffLayouts(record.layout, await localLayout(V2_APPEND));
    expect(result.ok).toBe(true);
  }, 120_000);

  it("fails an insertion at the start of the namespace, naming the field", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = diffLayouts(record.layout, await localLayout(V2_INSERT));
    expect(result.ok).toBe(false);
    expect(result.ops.map((op) => op.kind)).toContain("insert");
  }, 120_000);

  it("accepts a build tool's input with non-standard top-level keys (Foundry build-info)", async () => {
    const foundryInput = {
      ...input(V1),
      version: "0.8.24",
      allowPaths: ["/project"],
      basePath: "/project",
      includePaths: [],
    } as SolcInput;
    const layout = (await analyzeSource(foundryInput, solc, "contracts/Box.sol:Box")).layout;
    expect(layout).toEqual(await localLayout(V1));
  }, 120_000);

  it("refuses verified source built without a source hash, even when the code matches", async () => {
    // Deployed: a uint256 nothing reads. Verified: a bytes32 there. Same code.
    const noHash = (content: string): SolcInput => {
      const i = input(content);
      return { ...i, settings: { ...i.settings, metadata: { bytecodeHash: "none" } } } as SolcInput;
    };
    const live = source("        uint256 value;", "    uint256 private unused;");
    const verified = source("        uint256 value;", "    bytes32 private unused;");
    const out = await solc.compile({
      ...noHash(live),
      settings: {
        ...noHash(live).settings,
        outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
      },
    } as SolcInput);
    const code =
      "0x" +
      (
        out.contracts["contracts/Box.sol"].Box as unknown as {
          evm: { deployedBytecode: { object: string } };
        }
      ).evm.deployedBytecode.object;
    // Without immutables filled in, the masked comparison is identical either way.
    const chain = makeMockChain({ code: { [IMPL]: code }, implementations: { [PROXY]: IMPL } });
    vi.stubGlobal("fetch", explorerServing(noHash(verified)));
    const err = await resolveProxyLayout(chain, PROXY, { explorer: { apiKey: "KEY" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/no source hash/);
  }, 120_000);

  it("refuses a build without CBOR whose code ends in a literal shaped like a metadata hash", async () => {
    // With appendCBOR false, a long bytes literal lands at the very end of the
    // code, so it can mimic solc's metadata, ipfs hash and length suffix included.
    const fake = "a1" + "6469706673" + "5822" + "1220" + "ab".repeat(32) + "002a";
    const content = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract Box {
    uint256 public version;

    function blob() external pure returns (bytes memory) {
        return hex"${"00".repeat(120)}${fake}";
    }
}
`;
    const crafted: SolcInput = {
      ...input(content),
      settings: { ...input(content).settings, metadata: { appendCBOR: false } },
    } as SolcInput;
    const out = await solc.compile({
      ...crafted,
      settings: {
        ...crafted.settings,
        outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
      },
    } as SolcInput);
    const code =
      "0x" +
      (
        out.contracts["contracts/Box.sol"].Box as unknown as {
          evm: { deployedBytecode: { object: string } };
        }
      ).evm.deployedBytecode.object;
    expect(code.endsWith(fake)).toBe(true); // the test is meaningless unless the tail is the fake

    const chain = makeMockChain({ code: { [IMPL]: code }, implementations: { [PROXY]: IMPL } });
    vi.stubGlobal("fetch", explorerServing(crafted));
    const err = await resolveProxyLayout(chain, PROXY, { explorer: { apiKey: "KEY" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/no source hash/);
  }, 120_000);

  it("extracts the layout of the contract asked for when another compiles to the same code", async () => {
    const both = {
      language: "Solidity",
      sources: {
        "contracts/A.sol": {
          content:
            "pragma solidity 0.8.24; contract Alpha { uint256 public a; bytes32 private dep; }",
        },
        "contracts/Box.sol": {
          content:
            "pragma solidity 0.8.24; contract Box { uint256 public a; uint256 private dep; }",
        },
      },
      settings: { optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: "none" } },
    } as unknown as SolcInput;
    const layout = (await analyzeSource(both, solc, "contracts/Box.sol:Box")).layout;
    expect(layout.storage.map((s) => `${s.contract}.${s.label}:${s.type}`)).toEqual([
      "Box.a:t_uint256",
      "Box.dep:t_uint256",
    ]);
  }, 120_000);

  it("fails a narrowing type change inside the namespace", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = diffLayouts(record.layout, await localLayout(V2_RETYPE));
    expect(result.ok).toBe(false);
  }, 120_000);
});
