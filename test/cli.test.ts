/**
 * The CLI end to end with a real solc: local sides come from build info
 * written to a temporary project, address sides from a mock chain behind the
 * CLI's own JSON-RPC client and a stubbed explorer.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SolcInput } from "@openzeppelin/upgrades-core";
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
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    cwd: root,
    env,
    fetch: fetchImpl as never,
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

  it("takes an address that is not a proxy as an implementation", async () => {
    const r = await cli([IMPL, "V2", "--rpc", RPC]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `old  ${IMPL} (implementation)\n     src/V1.sol:V1 (verified source, exact match)`,
    );
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

  it("prints help and the version", async () => {
    expect((await cli(["--help"])).stdout).toContain("Usage: slotdiff");
    expect((await cli(["-v"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});
