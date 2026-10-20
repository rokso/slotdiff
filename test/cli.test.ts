/**
 * The CLI end to end with a real solc: local sides come from build info
 * written to a temporary project, address sides from a mock chain behind the
 * CLI's own JSON-RPC client and a stubbed explorer.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { SolcInput } from "@openzeppelin/upgrades-core";
import { calculateERC7201StorageLocation as slotOf } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
import { run } from "../src/cli.js";
import { getSolc, type SolcRunner } from "../src/solc.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const ADMIN = "0x00000000000000000000000000000000000000cc";
const BEACON = "0x00000000000000000000000000000000000000dd";

const SOLC = "0.8.24+commit.e11b9ed9";
const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const RPC = "http://rpc.test/secret-key";

const header = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n";
const UPGRADE = "function upgradeToAndCall(address, bytes calldata) external payable {}";
const bump = (slot: string) => "0x" + (BigInt(slot) + 1n).toString(16).padStart(64, "0");

// A contract with one ERC-7201 namespace annotated `id`, stored at `slot`.
function namespaced(name: string, id: string, slot: string, fields = "uint256 shutdown;"): string {
  return `${header}contract ${name} {
    /// @custom:storage-location erc7201:${id}
    struct S { ${fields} }
    bytes32 private constant LOCATION = ${slot};
    function _s() private pure returns (S storage $) { assembly { $.slot := LOCATION } }
    function shutdown() external view returns (uint256) { return _s().shutdown; }
}\n`;
}
// NewShut plus a namespace `x.reserved` kept for later: no code assigns it, or code at `slot`.
function reserved(name: string, slot?: string): string {
  const use =
    slot === undefined
      ? ""
      : `function _r() private pure returns (R storage $) { assembly { $.slot := ${slot} } }
    function r() external view returns (uint256) { return _r().a; }`;
  // The first annotation is S's; R goes in front of it.
  return namespaced(name, "x.shutdown.real", slotOf("x.shutdown.real")).replace(
    "    /// @custom:storage-location",
    `    /// @custom:storage-location erc7201:x.reserved
    struct R { uint256 a; }
    ${use}
    /// @custom:storage-location`,
  );
}
const SOURCES: Record<string, string> = {
  "src/V1.sol": `${header}contract V1 { uint256 public a; address public owner; }\n`,
  "src/V2.sol": `${header}contract V2 { uint256 public a; address public owner; uint256 public added; }\n`,
  "src/Bad.sol": `${header}contract Bad { uint256 public inserted; uint256 public a; address public owner; }\n`,
  "src/Renamed.sol": `${header}contract Renamed { uint256 public b; address public owner; }\n`,
  // For --safety: a UUPS implementation, one that lost its upgrade function, constructors.
  "src/Uups.sol": `${header}contract Uups { uint256 public a; address public owner; ${UPGRADE} }\n`,
  "src/Lost.sol": `${header}contract Lost { uint256 public a; address public owner; }\n`,
  "src/Ctor.sol": `${header}contract Ctor { uint256 public a; address public owner; constructor() { a = 1; } }\n`,
  "src/BadCtor.sol": `${header}contract BadCtor { uint256 public inserted; uint256 public a; address public owner; constructor() { a = 1; } }\n`,
  // The annotation was wrong in the deployed version and fixed later; the slot never moved.
  "src/OldShut.sol": namespaced("OldShut", "x.shutdown", slotOf("x.shutdown.real")),
  "src/NewShut.sol": namespaced("NewShut", "x.shutdown.real", slotOf("x.shutdown.real")),
  // The slot moved behind an unchanged annotation.
  "src/NewMoved.sol": namespaced("NewMoved", "x.shutdown.real", slotOf("x.elsewhere")),
  // The annotation corrected to where the old data is, but the slot then moved by one.
  "src/NewOff.sol": namespaced("NewOff", "x.shutdown.real", bump(slotOf("x.shutdown.real"))),
  "src/NewOffInsert.sol": namespaced(
    "NewOffInsert",
    "x.shutdown.real",
    bump(slotOf("x.shutdown.real")),
    "uint256 inserted; uint256 shutdown;",
  ),
  // OldShut's constant changed to match its wrong annotation: the data is left behind.
  "src/FixedConst.sol": namespaced("FixedConst", "x.shutdown", slotOf("x.shutdown")),
  // A slot slotdiff cannot read.
  "src/Unread.sol": namespaced("Unread", "x.shutdown.real", slotOf("x.shutdown.real")).replace(
    "assembly { $.slot := LOCATION }",
    'bytes32 l = keccak256("x"); assembly { $.slot := l }',
  ),
  "src/NoNs.sol": `${header}contract NoNs { uint256 private x; }\n`,
  // OldShut's namespace kept, wrong annotation and all, but no code assigns it any more.
  "src/ShutDropped.sol": `${header}contract ShutDropped {
    /// @custom:storage-location erc7201:x.shutdown
    struct S { uint256 shutdown; }
}\n`,
  // A reserved namespace: never assigned, then assigned where its annotation says, or elsewhere.
  "src/Reserved.sol": reserved("Reserved"),
  "src/ReservedUsed.sol": reserved("ReservedUsed", slotOf("x.reserved")),
  "src/ReservedElsewhere.sol": reserved("ReservedElsewhere", slotOf("x.elsewhere")),
  "src/CtorAllowed.sol": `${header}contract CtorAllowed { uint256 public a; address public owner;
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { a = 1; } }\n`,
};

function input(sources: Record<string, string>): SolcInput {
  return {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { optimizer: { enabled: false, runs: 200 }, outputSelection: {} },
  } as SolcInput;
}

let solc: SolcRunner;
let root: string;
let v1Code: string;
let uupsCode: string;
let oldShutCode: string;

async function deployedCode(path: string, name: string): Promise<string> {
  const out = await solc.compile({
    ...input({ [path]: SOURCES[path] }),
    settings: {
      optimizer: { enabled: false, runs: 200 },
      outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
    },
  } as SolcInput);
  const compiled = out.contracts[path][name] as unknown as {
    evm: { deployedBytecode: { object: string } };
  };
  return "0x" + compiled.evm.deployedBytecode.object;
}

// The explorer verifies `name` from `path` as the implementation's source.
function serveVerified(path: string, name: string) {
  explorer = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: "1",
      result: [
        {
          SourceCode: `{${JSON.stringify(input({ [path]: SOURCES[path] }))}}`,
          ContractName: name,
          CompilerVersion: `v${SOLC}`,
        },
      ],
    }),
  }));
  vi.stubGlobal("fetch", explorer);
}

beforeAll(async () => {
  solc = await getSolc(SOLC);
  v1Code = await deployedCode("src/V1.sol", "V1");
  uupsCode = await deployedCode("src/Uups.sol", "Uups");
  oldShutCode = await deployedCode("src/OldShut.sol", "OldShut");

  // A Hardhat 2 shaped project: the reader only needs input, version and output contract names.
  root = await mkdtemp(join(tmpdir(), "slotdiff-cli-"));
  for (const [path, content] of Object.entries(SOURCES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await mkdir(join(root, "artifacts/build-info"), { recursive: true });
  await writeFile(
    join(root, "artifacts/build-info/a.json"),
    JSON.stringify({
      solcLongVersion: SOLC,
      input: input(SOURCES),
      output: {
        contracts: Object.fromEntries(
          Object.keys(SOURCES).map((p) => [p, { [p.slice(4, -4)]: {} }]),
        ),
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true });
});

let explorer: ReturnType<typeof vi.fn>;
// Node's own fetch, whose error messages quote the URL in some cases.
const realFetch = globalThis.fetch;

beforeEach(() => {
  serveVerified("src/V1.sol", "V1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The mock chain behind a JSON-RPC endpoint, as the CLI's client sees it.
function rpcFetch(
  chain = makeMockChain({ code: { [IMPL]: v1Code }, implementations: { [PROXY]: IMPL } }),
) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
    try {
      return Response.json({ jsonrpc: "2.0", id, result: await chain.send(method, params) });
    } catch (e) {
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (e as Error).message },
      });
    }
  });
}

async function cli(
  args: string[],
  fetchImpl: ReturnType<typeof vi.fn> = rpcFetch(),
  env: Record<string, string> = { ETHERSCAN_API_KEY: "KEY" },
  terminal: { tty?: boolean; color?: boolean } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    cwd: root,
    env,
    fetch: fetchImpl as never,
    ...terminal,
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("slotdiff CLI", () => {
  it("passes a compatible local upgrade", async () => {
    const r = await cli(["src/V1.sol:V1", "V2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("old  src/V1.sol:V1\n     artifacts/build-info/a.json");
    expect(r.stdout).toContain("✓ Storage layout   compatible");
    expect(r.stdout).toContain("✓ Safety rules     no problems found (transparent proxy)");
    expect(r.stdout).toMatch(/\nSafe to upgrade.$/);
  }, 60_000);

  it("fails an incompatible local upgrade with OpenZeppelin's explanation", async () => {
    const r = await cli(["V1", "Bad"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ Storage layout   incompatible\n    src/Bad.sol:");
    expect(r.stdout).toMatch(/src\/Bad.sol:\d+: Inserted `inserted`/);
    // Safe code does not rescue a broken layout, and the verdict says so.
    expect(r.stdout).toContain("✓ Safety rules     no problems found (transparent proxy)");
    expect(r.stdout).toMatch(/\nNot safe to upgrade: the storage layout is incompatible.$/);
  }, 60_000);

  it("passes renames through only with --unsafe-allow-renames", async () => {
    expect((await cli(["V1", "Renamed"])).code).toBe(1);
    expect((await cli(["V1", "Renamed", "--unsafe-allow-renames"])).code).toBe(0);
  }, 60_000);

  it("compares what a proxy runs with a local build", async () => {
    const r = await cli([PROXY, "V2", "--rpc", RPC]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `old  ${PROXY} → implementation ${IMPL}\n     src/V1.sol:V1 (verified source, exact match)`,
    );
    expect(String(explorer.mock.calls[0][0])).toContain("apikey=KEY");
  }, 60_000);

  it("echoes no terminal escapes from its own arguments", async () => {
    const r = await cli(["V1", "V2", "--build-info", "x\u001b[2K.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^Could not check: Cannot read .*x \[2K\.json/);
    expect(r.stderr).not.toContain("\u001b");
  }, 60_000);

  it("prints no terminal escapes an explorer sends", async () => {
    explorer = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "0", result: "\u001b[1A\u001b[2K\u001b[32mSafe to upgrade." }),
    }));
    vi.stubGlobal("fetch", explorer);
    const r = await cli([PROXY, "V2", "--rpc", RPC]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Could not check: Explorer could not answer:");
    expect(r.stderr).not.toContain("\u001b");
  }, 60_000);

  it("never sends the Etherscan key to another explorer", async () => {
    const r = await cli([PROXY, "V2", "--rpc", RPC, "--explorer-url", "https://other.test/api"]);
    expect(r.code).toBe(0);
    const url = String(explorer.mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/other\.test\/api\?/);
    expect(url).not.toContain("KEY");
  }, 60_000);

  it("exits 2 when the RPC endpoint answers JSON that is not JSON-RPC", async () => {
    const r = await cli(
      [PROXY, "V2", "--rpc", RPC],
      vi.fn(async () => Response.json({ hello: "world" })),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("Could not check: The RPC endpoint did not answer JSON-RPC.");
  });

  it("fails a proxy against an incompatible local build", async () => {
    const r = await cli([PROXY, "Bad", "--rpc", RPC]);
    expect(r.code).toBe(1);
  }, 60_000);

  // A proxy slotdiff cannot read (a diamond, a custom slot) would otherwise be
  // compared as its own, nearly empty, code and pass.
  it("refuses an <old> address that is not a proxy unless told it is an implementation", async () => {
    const r = await cli([IMPL, "V2", "--rpc", RPC]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("Safe to upgrade");
    expect(r.stderr).toContain(`Could not check: ${IMPL} is not a proxy slotdiff can read`);
    expect(r.stderr).toContain("pass --old-implementation");
    expect(explorer).not.toHaveBeenCalled();
  });

  it("takes an <old> implementation address with --old-implementation", async () => {
    const r = await cli([IMPL, "V2", "--rpc", RPC, "--old-implementation"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `old  ${IMPL} (implementation)\n     src/V1.sol:V1 (verified source, exact match)`,
    );
  }, 60_000);

  it("refuses --old-implementation for a proxy, and for a local <old>", async () => {
    const proxy = await cli([PROXY, "V2", "--rpc", RPC, "--old-implementation"]);
    expect(proxy.code).toBe(2);
    expect(proxy.stderr).toContain(`${PROXY} is a proxy, not an implementation`);
    const local = await cli(["V1", "V2", "--old-implementation"]);
    expect(local.code).toBe(2);
    expect(local.stderr).toBe("--old-implementation needs <old> to be an address.");
  });

  it("still takes a <new> implementation address as it is", async () => {
    const r = await cli(["V1", IMPL, "--rpc", RPC]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`new  ${IMPL} (implementation)`);
  }, 60_000);

  it("exits 2 for an address with no code", async () => {
    const r = await cli([ADMIN, "V2", "--rpc", RPC]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Could not check: No code at/);
  });

  it("resolves the same proxy once when it is both sides, and checks its safety rules", async () => {
    const r = await cli([PROXY, PROXY, "--rpc", RPC]);
    expect(r.code).toBe(0);
    expect(explorer).toHaveBeenCalledTimes(1);
    expect(r.stdout).toContain("✓ Safety rules     no problems found (transparent proxy)");
    expect(r.stdout).toMatch(/\nSafe to upgrade.$/);
  }, 60_000);

  it("checks the safety rules of verified source when <new> is an address", async () => {
    const r = await cli(["Bad", PROXY, "--rpc", RPC]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✓ Safety rules     no problems found");
    expect(r.stdout).toMatch(/\nNot safe to upgrade: the storage layout is incompatible.$/);
  }, 60_000);

  it("names both problems when both checks fail", async () => {
    const r = await cli(["V1", "BadCtor"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /\nNot safe to upgrade: the storage layout is incompatible and <new> breaks the safety rules.$/,
    );
  }, 60_000);

  describe("ERC-7201 slots", () => {
    const short = (slot: string) => `${slot.slice(0, 6)}…${slot.slice(-4)}`;

    it("matches namespaces by the slot the code uses, not the annotation", async () => {
      const r = await cli(["OldShut", "NewShut"]);
      const lines = r.stdout.split("\n");
      const at = lines.indexOf("ERC-7201 namespaces");
      expect(lines.slice(at, at + 5)).toEqual([
        "ERC-7201 namespaces",
        "       annotation        slot from annotation   slot in code",
        `  old  x.shutdown        ${short(slotOf("x.shutdown"))}            ${short(slotOf("x.shutdown.real"))}    ✗ annotation does not match code`,
        `  new  x.shutdown.real   ${short(slotOf("x.shutdown.real"))}            ${short(slotOf("x.shutdown.real"))}    ✓`,
        "       Same slot in code on both sides: the storage did not move. Compared as one namespace.",
      ]);
      expect(r.stdout).toContain("✓ ERC-7201 slots   compared by the slot in code (see above)");
      expect(r.stdout).toContain("✓ Storage layout   compatible");
      expect(r.code).toBe(0);
    }, 60_000);

    it("does the same when <old> is what a proxy runs", async () => {
      serveVerified("src/OldShut.sol", "OldShut");
      const chain = makeMockChain({
        code: { [IMPL]: oldShutCode },
        implementations: { [PROXY]: IMPL },
      });
      const r = await cli([PROXY, "NewShut", "--rpc", RPC], rpcFetch(chain));
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("Same slot in code on both sides");
      expect(r.code).toBe(0);
    }, 60_000);

    it("fails a slot that moved behind an unchanged annotation", async () => {
      const r = await cli(["NewShut", "NewMoved"]);
      expect(r.stdout).toContain(
        `  new  x.shutdown.real   ${short(slotOf("x.shutdown.real"))}            ${short(slotOf("x.elsewhere"))}    ✗ annotation does not match code`,
      );
      expect(r.stdout).toContain(
        `The new code moves this namespace from ${short(slotOf("x.shutdown.real"))} to ${short(slotOf("x.elsewhere"))}`,
      );
      expect(r.stdout).toContain("✗ ERC-7201 slots   problems found in <new> (see above)");
      expect(r.stdout).toMatch(
        /\nNot safe to upgrade: an ERC-7201 namespace fails the slot check.$/,
      );
      expect(r.code).toBe(1);
    }, 60_000);

    // Where the slot check owns the namespace, OpenZeppelin judges only the struct.
    it("reports a moved slot once, as a slot problem, not a deleted namespace", async () => {
      const r = await cli(["OldShut", "NewOff"]);
      expect(r.stdout).toContain("The new code moves this namespace from");
      expect(r.stdout).toContain("✓ Storage layout   compatible");
      expect(r.stdout).not.toContain("Deleted namespace");
      expect(r.code).toBe(1);
    }, 60_000);

    it("still lets OpenZeppelin catch a change inside a moved namespace", async () => {
      const r = await cli(["OldShut", "NewOffInsert"]);
      expect(r.stdout).toContain("✗ Storage layout   incompatible");
      expect(r.stdout).toMatch(/Inserted `inserted`/);
      expect(r.code).toBe(1);
    }, 60_000);

    it("fails a constant changed to match an annotation the deployed code did not follow", async () => {
      const r = await cli(["OldShut", "FixedConst"]);
      expect(r.stdout).toContain(
        `The new code moves this namespace from ${short(slotOf("x.shutdown.real"))} to ${short(slotOf("x.shutdown"))}`,
      );
      expect(r.stdout).toMatch(
        /\nNot safe to upgrade: an ERC-7201 namespace fails the slot check.$/,
      );
      expect(r.code).toBe(1);
    }, 60_000);

    it("exits 2 when a slot cannot be read, never reporting it safe", async () => {
      const r = await cli(["NewShut", "Unread"]);
      expect(r.stdout).toContain("? slot in code not read");
      expect(r.stdout).toContain(
        "- ERC-7201 slots   not checked: some slots could not be read (see above)",
      );
      expect(r.stdout).toMatch(/\nCould not check: some ERC-7201 slots could not be read.$/);
      expect(r.code).toBe(2);
    }, 60_000);

    // A namespace no code assigns is compared by its annotation, as OpenZeppelin does.
    it.each([
      ["never assigned on either side", "Reserved", "Reserved"],
      ["assigned where its annotation says", "Reserved", "ReservedUsed"],
    ])(
      "passes a reserved namespace %s, counted in the summary",
      async (_, old, next) => {
        const r = await cli([old, next]);
        expect(r.stdout).not.toContain("ERC-7201 namespaces");
        expect(r.stdout).toContain(
          "✓ ERC-7201 slots   match their annotations; 1 not assigned in code, compared by annotation",
        );
        expect(r.code).toBe(0);
      },
      60_000,
    );

    it("shows a namespace the new code stops assigning", async () => {
      const r = await cli(["ReservedUsed", "Reserved"]);
      expect(r.stdout).toMatch(
        new RegExp(
          `\\n  new  x\\.reserved +${short(slotOf("x.reserved"))} +none +· not assigned in code\\n`,
        ),
      );
      expect(r.stdout).toContain(
        "The new code no longer assigns this namespace; its data stays at",
      );
      expect(r.code).toBe(0);
    }, 60_000);

    it("fails dropping a namespace whose deployed annotation is wrong, while the slot is known", async () => {
      const r = await cli(["OldShut", "ShutDropped"]);
      expect(r.stdout).toContain(
        `The new code stops assigning this namespace while its data is at ${short(slotOf("x.shutdown.real"))}`,
      );
      expect(r.stdout).toMatch(
        /\nNot safe to upgrade: an ERC-7201 namespace fails the slot check.$/,
      );
      expect(r.code).toBe(1);
    }, 60_000);

    it("fails a reserved namespace assigned elsewhere", async () => {
      const r = await cli(["Reserved", "ReservedElsewhere"]);
      expect(r.stdout).toContain("in a different slot than its annotation says");
      expect(r.code).toBe(1);
    }, 60_000);

    it("leaves a namespace that is really gone to OpenZeppelin", async () => {
      const r = await cli(["NewShut", "NoNs"]);
      expect(r.stdout).toContain("Deleted namespace `erc7201:x.shutdown.real`");
      expect(r.stdout).not.toContain("ERC-7201 namespaces");
      expect(r.code).toBe(1);
    }, 60_000);

    it("shows no grid when every slot matches", async () => {
      const r = await cli(["NewShut", "NewShut"]);
      expect(r.stdout).not.toContain("ERC-7201 namespaces");
      expect(r.stdout).toContain("✓ ERC-7201 slots   match their annotations");
      expect(r.code).toBe(0);
    }, 60_000);

    it("leaves the ERC-7201 check out for a contract with no namespaces", async () => {
      const r = await cli(["V1", "V2"]);
      expect(r.stdout).not.toContain("ERC-7201");
    }, 60_000);
  });

  describe("safety rules", () => {
    it("is skipped with --no-safety", async () => {
      const r = await cli(["Uups", "Lost", "--no-safety"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("- Safety rules     skipped (--no-safety)");
      expect(r.stdout).toMatch(
        /\nStorage layout compatible; safety rules not checked \(--no-safety\).$/,
      );
    }, 60_000);

    it("takes the kind from <old>, so a UUPS implementation that lost upgradeToAndCall fails", async () => {
      const r = await cli(["Uups", "Lost"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("✓ Storage layout   compatible");
      expect(r.stdout).toContain(
        "✗ Safety rules     problems found (uups proxy)\n    src/Lost.sol:",
      );
      expect(r.stdout).toMatch(/src\/Lost.sol:\d+: .*upgradeTo/);
      expect(r.stdout).toMatch(/\nNot safe to upgrade: <new> breaks the safety rules.$/);
    }, 60_000);

    it("fails a constructor, unless the source or --unsafe-allow allows it", async () => {
      const r = await cli(["V1", "Ctor"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/has a constructor/);
      expect((await cli(["V1", "CtorAllowed"])).code).toBe(0);
      expect((await cli(["V1", "Ctor", "--unsafe-allow", "delegatecall, constructor"])).code).toBe(
        0,
      );
    }, 60_000);

    // OZ's detectProxyKind reads the admin slot, which a UUPS proxy can have set
    // (and it is deprecated for that); the kind comes from the implementation's code.
    it.each([
      ["no admin slot", {}],
      ["an admin slot set", { admins: { [PROXY]: ADMIN } }],
    ])(
      "infers UUPS from what the proxy runs, with %s",
      async (_, extra) => {
        serveVerified("src/Uups.sol", "Uups");
        const chain = makeMockChain({
          code: { [IMPL]: uupsCode },
          implementations: { [PROXY]: IMPL },
          ...extra,
        });
        const r = await cli([PROXY, "Lost", "--rpc", RPC], rpcFetch(chain));
        expect(r.code).toBe(1);
        expect(r.stdout).toContain("✗ Safety rules     problems found (uups proxy)");
      },
      60_000,
    );

    it("infers transparent when what the proxy runs has no upgrade function", async () => {
      const r = await cli([PROXY, "Lost", "--rpc", RPC]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("✓ Safety rules     no problems found (transparent proxy)");
    }, 60_000);

    it("reads a beacon proxy as beacon, whatever its implementation", async () => {
      serveVerified("src/Uups.sol", "Uups");
      const chain = makeMockChain({
        code: { [IMPL]: uupsCode },
        beacons: { [PROXY]: BEACON },
        beaconImplementations: { [BEACON]: IMPL },
      });
      const r = await cli([PROXY, "Lost", "--rpc", RPC], rpcFetch(chain));
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`→ implementation ${IMPL} (via beacon ${BEACON})`);
      expect(r.stdout).toContain("✓ Safety rules     no problems found (beacon proxy)");
    }, 60_000);

    it.each([
      [
        ["V1", "V2", "--no-safety", "--unsafe-allow", "constructor"],
        /does nothing with --no-safety/,
      ],
      [["V1", "V2", "--unsafe-allow", "nope"], /unknown error kind "nope"/],
    ])("exits 2 for %j", async (args, message) => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(message);
    });
  });

  it("names the key it needs to fetch verified source", async () => {
    const r = await cli([PROXY, "V2", "--rpc", RPC], rpcFetch(), {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`Could not check: ${IMPL} needs an explorer key`);
    expect(r.stderr).toContain("set ETHERSCAN_API_KEY");
  });

  it("reports an address with no code before asking for an explorer key", async () => {
    const r = await cli([ADMIN, "V2", "--rpc", RPC], rpcFetch(), {});
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Could not check: No code at/);
  });

  it("refuses an address that is too short, as an address", async () => {
    const r = await cli(["0x1234", "V2"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("0x1234 is not an address: an address is 0x and 40 hex digits.");
  });

  it("exits 2 for a wrong number of arguments", async () => {
    const r = await cli(["V1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^Expected <old> and <new>, got 1 argument/);
  });

  it("needs --rpc for an address", async () => {
    const r = await cli([PROXY, "V2"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--rpc");
  });

  it("exits 2 without the RPC URL when the endpoint is unreachable", async () => {
    const r = await cli(
      [PROXY, "V2", "--rpc", RPC],
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cannot reach the RPC endpoint");
    expect(r.stderr).not.toContain("secret-key");
  });

  it("exits 2 with the endpoint's error text, without control characters", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("bad\u001b[31m red")) };
    const r = await cli([PROXY, "V2", "--rpc", RPC], rpcFetch(failing as never));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/RPC eth_\w+ failed: bad \[31m red/);
  });

  describe("never prints a URL or key", () => {
    it.each([
      ["no scheme", "eth.example.com/v2/SECRET", /--rpc is not a valid URL/],
      ["credentials, unreachable", "http://user:SECRET@127.0.0.1:59999/v2/SECRET", /ECONNREFUSED/],
      ["key in the path, unreachable", "http://127.0.0.1:59999/v2/SECRET", /ECONNREFUSED/],
    ])("--rpc with %s", async (_, url, message) => {
      const r = await cli([PROXY, "V2", "--rpc", url], realFetch as never);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toContain("SECRET");
    });

    it("a URL given as a side", async () => {
      const r = await cli(["https://rpc.test/v2/SECRET", "V2"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--rpc");
      expect(r.stderr).not.toContain("SECRET");
    });

    it("--explorer-url with credentials", async () => {
      const r = await cli([
        PROXY,
        "V2",
        "--rpc",
        RPC,
        "--explorer-url",
        "https://u:SECRET@x.test/api",
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--explorer-url must not include");
      expect(r.stderr).not.toContain("SECRET");
    });
  });

  it("sends credentials in the --rpc URL as basic auth", async () => {
    const fetchImpl = rpcFetch();
    const r = await cli([PROXY, "V2", "--rpc", "https://alice:p%40ss@rpc.test/x"], fetchImpl);
    expect(r.code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://rpc.test/x");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("alice:p@ss").toString("base64")}`,
    );
  }, 60_000);

  it("reads --build-info relative to the current directory, not --root", async () => {
    const r = await cli([
      "V1",
      "V2",
      "--root",
      "elsewhere",
      "--build-info",
      "artifacts/build-info/a.json",
    ]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  }, 60_000);

  it("says a missing --build-info file is missing", async () => {
    const r = await cli(["V1", "V2", "--build-info", "nope.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cannot read");
    expect(r.stderr).toContain("ENOENT");
  });

  it("exits 2 for an unknown contract", async () => {
    const r = await cli(["V1", "Nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Could not check");
  });

  it.each([[["V1"]], [["V1", "V2", "V3"]], [["V1", "V2", "--nope"]]])(
    "exits 2 with a one-line pointer to --help for %j",
    async (args) => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^[^\n]+\. Run slotdiff --help for usage\.$/);
    },
  );

  describe("on a terminal", () => {
    const BANNER_LINE = "|___/_|\\___/ \\__\\__,_|_|_| |_|";

    it("colors the report without moving a column", async () => {
      const args = ["NewShut", "NewMoved"];
      const plainRun = await cli(args);
      const colored = await cli(args, undefined, undefined, { color: true });
      // A red ✗ on the failing check and a red verdict; plain text is what is aligned.
      expect(colored.stdout).toContain("\x1b[31m✗\x1b[39m \x1b[1mERC-7201 slots\x1b[22m");
      expect(colored.stdout).toContain("\x1b[31mNot safe to upgrade:");
      expect(stripVTControlCharacters(colored.stdout)).toBe(plainRun.stdout);
      expect(colored.code).toBe(plainRun.code);
    }, 60_000);

    it("shows the banner only on a terminal, and never colors without color", async () => {
      const shown = await cli(["V1", "V2"], undefined, undefined, { tty: true });
      expect(shown.stdout.split("\n")[4]).toBe(BANNER_LINE);
      expect(shown.stdout).toContain(" storage layout diff for upgradeable contracts · ");
      expect(shown.stdout).not.toContain("\x1b[");
      expect((await cli(["V1", "V2"])).stdout).not.toContain(BANNER_LINE);
    }, 60_000);

    it('draws "slot" and "diff" in two colors, the same letters as without color', async () => {
      const banner = (color: boolean) =>
        cli(["--version"], undefined, undefined, { tty: true, color }).then((r) => r.stdout);
      const colored = await banner(true);
      const [slot, diff] = [String.raw`|___/_|\___/ \__`, String.raw`\__,_|_|_| |_|`];
      expect(colored).toContain(`\x1b[94m${slot}\x1b[39m\x1b[35m${diff}\x1b[39m`);
      expect(stripVTControlCharacters(colored)).toBe(await banner(false));
    });

    it("puts the banner on --help and --version, but a bare version in a pipe", async () => {
      const tty = { tty: true };
      expect((await cli(["--help"], undefined, undefined, tty)).stdout).toContain(BANNER_LINE);
      expect((await cli(["--version"], undefined, undefined, tty)).stdout).toContain(BANNER_LINE);
      expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    });
  });

  it("prints help and the version", async () => {
    expect((await cli(["--help"])).stdout).toContain("Usage: slotdiff");
    expect((await cli(["-v"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});
