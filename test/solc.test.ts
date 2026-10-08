import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { getSolc } from "../src/solc.js";
import { LayoutIntegrityError, LayoutUnavailableError } from "../src/errors.js";

// A version no cache holds, so getSolc must go to the (mocked) download.
const UNCACHED = "0.0.1+commit.00000000";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "hhuv-solc-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true });
});

function listing(sha256: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ builds: [{ path: "solc-x", longVersion: UNCACHED, sha256 }] }),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe("getSolc", () => {
  it("treats an unreachable download host as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
  });

  it("treats a version with no native build as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ builds: [] }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
  });

  it("refuses a binary that fails its checksum, as an integrity failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listing("0x" + "00".repeat(32)))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("not solc").buffer,
      });
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(LayoutIntegrityError);
  });

  it("rejects instead of crashing when the compiler exits before reading its input", async () => {
    const solc = await getSolc(UNCACHED, { resolvePath: () => "/usr/bin/true" });
    const big = { language: "Solidity", sources: { "a.sol": { content: "x".repeat(8_000_000) } } };
    await expect(solc.compile(big as never)).rejects.toThrow();
  });

  it("resolves a release version (as Foundry records it) to the release build, not a nightly", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\n");
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          builds: [
            { path: "nightly", longVersion: "0.0.1-nightly.2020.1.1+commit.11111111", sha256 },
            { path: "pre", longVersion: "0.0.1-pre.1+commit.44444444", sha256 },
            { path: "release", longVersion: "0.0.1+commit.22222222", sha256 },
            { path: "other", longVersion: "0.0.10+commit.33333333", sha256 },
          ],
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => bytes.buffer,
      });
    const solc = await getSolc("0.0.1", { cacheDir }, fetchImpl);
    expect(solc.longVersion).toBe("0.0.1+commit.22222222");
    expect(fetchImpl.mock.calls[1][0]).toMatch(/\/release$/);
    expect(solc.path).toMatch(/solc-[a-z0-9-]+-v0\.0\.1\+commit\.22222222(\.exe)?$/);
  });

  it("finds a cached release binary for a release version without the network", async () => {
    const platform = { darwin: "macosx-amd64", linux: "linux-amd64", win32: "windows-amd64" }[
      process.platform as "darwin" | "linux" | "win32"
    ];
    const ext = platform === "windows-amd64" ? ".exe" : "";
    const dir = join(cacheDir, platform);
    await mkdir(dir, { recursive: true });
    // Decoys: a nightly, a longer version sharing the prefix, an unfinished download.
    for (const v of ["0.0.1-nightly.2020.1.1+commit.11111111", "0.0.10+commit.33333333"]) {
      await writeFile(join(dir, `solc-${platform}-v${v}${ext}`), "", { mode: 0o755 });
    }
    await writeFile(join(dir, `solc-${platform}-v0.0.1+commit.22222222${ext}.123.tmp`), "", {
      mode: 0o755,
    });
    const real = join(dir, `solc-${platform}-v0.0.1+commit.22222222${ext}`);
    await writeFile(real, "");
    await chmod(real, 0o755);

    const fetchImpl = vi.fn().mockRejectedValue(new Error("no network"));
    const solc = await getSolc("0.0.1", { cacheDir }, fetchImpl);
    expect(solc).toMatchObject({ path: real, longVersion: "0.0.1+commit.22222222" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never takes a nightly, a longer version or an unfinished download for a release version", async () => {
    const platform = { darwin: "macosx-amd64", linux: "linux-amd64", win32: "windows-amd64" }[
      process.platform as "darwin" | "linux" | "win32"
    ];
    const ext = platform === "windows-amd64" ? ".exe" : "";
    const dir = join(cacheDir, platform);
    await mkdir(dir, { recursive: true });
    for (const name of [
      `solc-${platform}-v0.0.1-nightly.2020.1.1+commit.11111111${ext}`,
      `solc-${platform}-v0.0.10+commit.33333333${ext}`,
      `solc-${platform}-v0.0.1+commit.22222222${ext}.123.tmp`,
    ]) {
      await writeFile(join(dir, name), "", { mode: 0o755 });
    }
    const fetchImpl = vi.fn().mockRejectedValue(new Error("no network"));
    await expect(getSolc("0.0.1", { cacheDir }, fetchImpl)).rejects.toThrow(LayoutUnavailableError);
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("getSolc input and concurrency", () => {
  it.each(["../../bin/echo", "0.8.24/../../x", "latest", ""])(
    "refuses %j as a version before touching the filesystem or network",
    async (version) => {
      const resolvePath = vi.fn(() => "/bin/echo");
      const fetchImpl = vi.fn();
      await expect(getSolc(version, { cacheDir, resolvePath }, fetchImpl)).rejects.toThrow(
        LayoutUnavailableError,
      );
      expect(resolvePath).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("shares one download between concurrent callers", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\n");
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        builds: [{ path: "solc-bin", longVersion: "0.0.1+commit.22222222", sha256 }],
      }),
      arrayBuffer: async () => (url.endsWith("/solc-bin") ? bytes.buffer : new ArrayBuffer(0)),
    }));
    const runners = await Promise.all(
      Array.from({ length: 6 }, () => getSolc("0.0.1+commit.22222222", { cacheDir }, fetchImpl)),
    );
    expect(new Set(runners.map((r) => r.path)).size).toBe(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/solc-bin"))).toHaveLength(
      1,
    );
  });

  it("accepts a pre-release version", async () => {
    const solc = await getSolc("0.8.31-pre.1+commit.b59566f6", {
      resolvePath: () => "/usr/bin/true",
    });
    expect(solc.path).toBe("/usr/bin/true");
  });

  it("refuses a build published as a zip archive, as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        builds: [{ path: "solc-v0.0.1.zip", longVersion: "0.0.1+commit.22222222", sha256: "0x00" }],
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(getSolc("0.0.1+commit.22222222", { cacheDir }, fetchImpl)).rejects.toThrow(
      /zip archive/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never downloads it
  });
});
