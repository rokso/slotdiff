/**
 * The build-info reader against each tool's file shape, as written by real
 * builds (forge 1.8.3, Hardhat 2.x, Hardhat 3.19): Foundry's inline output,
 * short version, stale and input-less files; Hardhat 3's `project/` prefix and
 * separate `<id>.output.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { findBuildInfo } from "../src/build-info.js";

const VAULT = "contract Vault is Base { uint256 public total; }";
const BASE = "contract Base { address public owner; }";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slotdiff-build-info-"));
});

afterEach(async () => {
  await rm(root, { recursive: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

function compiled(object: string) {
  return { evm: { deployedBytecode: { object, immutableReferences: { "3": [] } } } };
}

function foundry(sources: Record<string, string>, settings: object = { optimizer: {} }) {
  return {
    id: "x",
    source_id_to_path: {},
    language: "Solidity",
    _format: "ethers-rs-sol-build-info-1",
    solcVersion: "0.8.30",
    solcLongVersion: "0.8.30",
    input: {
      version: "0.8.30",
      language: "Solidity",
      sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
      settings,
      allowPaths: [],
      basePath: "",
      includePaths: [],
    },
    output: {
      contracts: Object.fromEntries(
        Object.keys(sources).map((k) => [
          k,
          { [k.split("/").pop()!.replace(".sol", "")]: compiled(`0x${k.length}`) },
        ]),
      ),
    },
  };
}

// Adds solc's per-source ASTs, reduced to the import directives the reader follows.
function withImports<T extends ReturnType<typeof foundry>>(
  info: T,
  imports: Record<string, string[]>,
) {
  const sources = Object.fromEntries(
    Object.keys(info.input.sources).map((source) => [
      source,
      {
        ast: {
          nodeType: "SourceUnit",
          nodes: (imports[source] ?? []).map((absolutePath) => ({
            nodeType: "ImportDirective",
            absolutePath,
          })),
        },
      },
    ]),
  );
  return { ...info, output: { ...info.output, sources } };
}

describe("findBuildInfo", () => {
  describe("Foundry", () => {
    beforeEach(async () => {
      await put("src/Vault.sol", VAULT);
      await put("src/Base.sol", BASE);
    });

    it("picks the build whose sources match the disk, among stale and input-less files", async () => {
      // Sorted before the fresh one, so neither order nor first match can pick it.
      await put("out/build-info/a.json", foundry({ "src/Vault.sol": "old", "src/Base.sol": BASE }));
      await put("out/build-info/b.json", { id: "b", source_id_to_path: { 0: "src/Vault.sol" } });
      await put("out/build-info/c.json", foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }));

      const found = await findBuildInfo(root, "src/Vault.sol:Vault");
      expect(found.file).toBe(join(root, "out/build-info/c.json"));
      expect(found).toMatchObject({
        contract: "src/Vault.sol:Vault",
        solcVersion: "0.8.30",
        deployedBytecode: "0x13",
        immutableReferences: { "3": [] },
      });
      expect(Object.keys(found.input.sources)).toEqual(["src/Vault.sol", "src/Base.sol"]);
    });

    it("takes an absolute source path", async () => {
      await put("out/build-info/c.json", foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }));
      const found = await findBuildInfo(root, `${join(root, "src/Vault.sol")}:Vault`);
      expect(found.contract).toBe("src/Vault.sol:Vault");
    });

    it("does not take a name Object.prototype has for a contract", async () => {
      await put("out/build-info/c.json", foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }));
      await expect(findBuildInfo(root, "toString")).rejects.toThrow(/No build info holds toString/);
      await expect(findBuildInfo(root, "src/Vault.sol:toString")).rejects.toThrow(/No build info/);
    });

    it("treats a changed dependency as stale", async () => {
      await put(
        "out/build-info/a.json",
        foundry({ "src/Vault.sol": VAULT, "src/Base.sol": "old" }),
      );
      await expect(findBuildInfo(root, "src/Vault.sol:Vault")).rejects.toThrow(/older than the/);
    });

    it("says a build of a moved or deleted target is gone", async () => {
      await put("out/build-info/a.json", foundry({ "src/Gone.sol": "x", "src/Base.sol": BASE }));
      await expect(findBuildInfo(root, "src/Gone.sol:Gone")).rejects.toThrow(/no longer on disk/);
    });

    describe("after an incremental build", () => {
      // forge recompiles only changed files and what imports them, into a new
      // build-info file; the older file still holds everything else.
      it("keeps an older build when only a file the target does not import changed", async () => {
        await put("src/Other.sol", "new");
        await put(
          "out/build-info/a.json",
          withImports(
            foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE, "src/Other.sol": "old" }),
            {
              "src/Vault.sol": ["src/Base.sol"],
            },
          ),
        );
        await put("out/build-info/b.json", withImports(foundry({ "src/Other.sol": "new" }), {}));
        const found = await findBuildInfo(root, "src/Vault.sol:Vault");
        expect(found.file).toBe(join(root, "out/build-info/a.json"));
        // Only what the target imports is compiled again.
        expect(Object.keys(found.input.sources)).toEqual(["src/Vault.sol", "src/Base.sol"]);
      });

      it("still treats a changed indirect import as stale", async () => {
        await put("src/Mid.sol", "mid");
        await put("src/Base.sol", "changed");
        await put(
          "out/build-info/a.json",
          withImports(
            foundry({ "src/Vault.sol": VAULT, "src/Mid.sol": "mid", "src/Base.sol": BASE }),
            {
              "src/Vault.sol": ["src/Mid.sol"],
              "src/Mid.sol": ["src/Base.sol"],
            },
          ),
        );
        await expect(findBuildInfo(root, "src/Vault.sol:Vault")).rejects.toThrow(/older/);
      });

      it("still refuses a bare name a stale build also defines elsewhere", async () => {
        await put("test/Vault.sol", "new mock");
        await put(
          "out/build-info/a.json",
          withImports(
            foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE, "test/Vault.sol": "old" }),
            {
              "src/Vault.sol": ["src/Base.sol"],
            },
          ),
        );
        await put(
          "out/build-info/b.json",
          withImports(foundry({ "test/Vault.sol": "new mock" }), {}),
        );
        await expect(findBuildInfo(root, "Vault")).rejects.toThrow(/ambiguous/);
      });

      it("does not check a dependency it cannot find, such as hoisted node_modules", async () => {
        await put(
          "out/build-info/a.json",
          withImports(foundry({ "src/Vault.sol": VAULT, "@oz/Base.sol": BASE }), {
            "src/Vault.sol": ["@oz/Base.sol"],
          }),
        );
        expect((await findBuildInfo(root, "src/Vault.sol:Vault")).contract).toBe(
          "src/Vault.sol:Vault",
        );
      });

      it("ignores a stale definition whose file no longer declares the name", async () => {
        await put("src/Vault.sol", "contract VaultOld {}");
        await put("src/V2.sol", "contract Vault {}");
        await put(
          "out/build-info/a.json",
          withImports(foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }), {}),
        );
        const v2 = foundry({ "src/V2.sol": "contract Vault {}" });
        v2.output.contracts["src/V2.sol"] = { Vault: compiled("0xcc") } as never;
        await put("out/build-info/b.json", withImports(v2, {}));
        expect((await findBuildInfo(root, "Vault")).contract).toBe("src/V2.sol:Vault");
      });

      it("still counts a stale definition its file still declares", async () => {
        await put("src/Vault.sol", "contract Vault {} // edited");
        await put("src/V2.sol", "contract Vault {}");
        await put(
          "out/build-info/a.json",
          withImports(foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }), {}),
        );
        const v2 = foundry({ "src/V2.sol": "contract Vault {}" });
        v2.output.contracts["src/V2.sol"] = { Vault: compiled("0xcc") } as never;
        await put("out/build-info/b.json", withImports(v2, {}));
        await expect(findBuildInfo(root, "Vault")).rejects.toThrow(/ambiguous/);
      });

      it("ignores a second definition in a deleted file", async () => {
        await put(
          "out/build-info/a.json",
          withImports(
            foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE, "test/Vault.sol": "gone" }),
            {
              "src/Vault.sol": ["src/Base.sol"],
            },
          ),
        );
        expect((await findBuildInfo(root, "Vault")).contract).toBe("src/Vault.sol:Vault");
      });
    });

    it("resolves a bare name", async () => {
      await put("out/build-info/a.json", foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }));
      expect((await findBuildInfo(root, "Base")).contract).toBe("src/Base.sol:Base");
    });

    it("refuses a bare name two sources define", async () => {
      await put("lib/x/Vault.sol", "other");
      await put(
        "out/build-info/a.json",
        foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE, "lib/x/Vault.sol": "other" }),
      );
      await expect(findBuildInfo(root, "Vault")).rejects.toThrow(
        /ambiguous: src\/Vault.sol:Vault, lib\/x\/Vault.sol:Vault/,
      );
    });

    it("refuses fresh builds with different settings", async () => {
      const sources = { "src/Vault.sol": VAULT, "src/Base.sol": BASE };
      await put("out/build-info/a.json", foundry(sources, { optimizer: { enabled: true } }));
      await put("out/build-info/b.json", foundry(sources, { optimizer: { enabled: false } }));
      await expect(findBuildInfo(root, "src/Vault.sol:Vault")).rejects.toThrow(
        /different compilers or settings in out\/build-info\/a.json, out\/build-info\/b.json .*--build-info/,
      );
    });

    it("takes either of two fresh builds that differ only in output selection", async () => {
      const sources = { "src/Vault.sol": VAULT, "src/Base.sol": BASE };
      await put("out/build-info/a.json", foundry(sources, { outputSelection: { a: 1 } }));
      await put("out/build-info/b.json", foundry(sources, { outputSelection: { b: 2 } }));
      expect((await findBuildInfo(root, "src/Vault.sol:Vault")).file).toBe(
        join(root, "out/build-info/a.json"),
      );
    });

    it("says how to get full build info when only input-less files exist", async () => {
      await put("out/build-info/b.json", { id: "b", source_id_to_path: { 0: "src/Vault.sol" } });
      await expect(findBuildInfo(root, "src/Vault.sol:Vault")).rejects.toThrow(
        /no compiler input.*forge build --build-info/,
      );
    });

    it("does not find a name the source does not define", async () => {
      await put("out/build-info/a.json", foundry({ "src/Vault.sol": VAULT, "src/Base.sol": BASE }));
      await expect(findBuildInfo(root, "src/Vault.sol:Base")).rejects.toThrow(/No build info/);
    });

    it("uses an explicit file as is, without comparing it with the disk", async () => {
      await put("ci/a.json", foundry({ "src/Vault.sol": "old", "src/Base.sol": BASE }));
      const found = await findBuildInfo(root, "src/Vault.sol:Vault", { file: "ci/a.json" });
      expect(found.file).toBe(join(root, "ci/a.json"));
    });
  });

  describe("Hardhat 2", () => {
    it("reads the build info and checks dependencies in node_modules", async () => {
      await put("contracts/Vault.sol", VAULT);
      await put("node_modules/@oz/Base.sol", BASE);
      const info = {
        _format: "hh-sol-build-info-1",
        solcVersion: "0.8.24",
        solcLongVersion: "0.8.24+commit.e11b9ed9",
        input: {
          language: "Solidity",
          sources: { "contracts/Vault.sol": { content: VAULT }, "@oz/Base.sol": { content: BASE } },
          settings: {},
        },
        output: { contracts: { "contracts/Vault.sol": { Vault: compiled("0xaa") } } },
      };
      await put("artifacts/build-info/a.json", info);
      expect(await findBuildInfo(root, "contracts/Vault.sol:Vault")).toMatchObject({
        contract: "contracts/Vault.sol:Vault",
        solcVersion: "0.8.24+commit.e11b9ed9",
        deployedBytecode: "0xaa",
      });

      await put("node_modules/@oz/Base.sol", "changed");
      await expect(findBuildInfo(root, "contracts/Vault.sol:Vault")).rejects.toThrow(/older/);
    });
  });

  describe("Hardhat 3", () => {
    beforeEach(async () => {
      await put("contracts/Vault.sol", VAULT);
      await put("contracts/Base.sol", BASE);
      await put("artifacts/build-info/solc-1.json", {
        _format: "hh3-sol-build-info-1",
        id: "solc-1",
        solcVersion: "0.8.24",
        solcLongVersion: "0.8.24+commit.e11b9ed9",
        compilerType: "solc",
        userSourceNameMap: { "contracts/Vault.sol": "project/contracts/Vault.sol" },
        input: {
          language: "Solidity",
          sources: {
            "project/contracts/Vault.sol": { content: VAULT },
            // Not in userSourceNameMap, as for a file the build did not name directly.
            "project/contracts/Base.sol": { content: BASE },
            // Versioned npm paths have no file on disk to compare with.
            "npm/@oz/contracts@5.0.0/Base.sol": { content: BASE },
          },
          settings: {},
        },
      });
      await put("artifacts/build-info/solc-1.output.json", {
        _format: "hh3-sol-build-info-output-1",
        id: "solc-1",
        output: { contracts: { "project/contracts/Vault.sol": { Vault: compiled("0xbb") } } },
      });
    });

    it.each(["contracts/Vault.sol:Vault", "project/contracts/Vault.sol:Vault", "Vault"])(
      "finds %s with its output from <id>.output.json",
      async (name) => {
        expect(await findBuildInfo(root, name)).toMatchObject({
          file: join(root, "artifacts/build-info/solc-1.json"),
          contract: "project/contracts/Vault.sol:Vault",
          deployedBytecode: "0xbb",
        });
      },
    );

    it("maps project sources back to the disk", async () => {
      await put("contracts/Vault.sol", "changed");
      await expect(findBuildInfo(root, "Vault")).rejects.toThrow(/older/);
    });

    it("maps project sources missing from userSourceNameMap", async () => {
      await put("contracts/Base.sol", "changed");
      await expect(findBuildInfo(root, "Vault")).rejects.toThrow(/older/);
    });
  });

  it("explains where build info comes from when there is none", async () => {
    await expect(findBuildInfo(root, "Vault")).rejects.toThrow(
      /No build info found.*project root.*build_info/,
    );
  });

  it("names a project root that does not exist", async () => {
    await expect(findBuildInfo(join(root, "nope"), "Vault")).rejects.toThrow(
      `The project root ${join(root, "nope")} is not a directory.`,
    );
  });

  it("rejects a malformed contract name without quoting it", async () => {
    const failing = findBuildInfo(root, "https://rpc.test/v2/SECRET");
    await expect(failing).rejects.toThrow(/Expected a contract name/);
    await expect(failing).rejects.not.toThrow(/SECRET/);
  });
});
