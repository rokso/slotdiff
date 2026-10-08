/**
 * Native solc acquisition and invocation, independent of Hardhat's compiler
 * manager so the core stays usable outside a Hardhat runtime.
 *
 * Lookup order: explicit override, our cache, Hardhat's compiler caches (v3
 * then v2, so a project that already compiled with that version pays nothing),
 * then a download from binaries.soliditylang.org verified against the
 * published sha256.
 *
 * Takes a long version (`0.8.24+commit.e11b9ed9`) or a release version
 * (`0.8.24`, which is what Foundry's build-info records); a release version
 * resolves to that release's build, never a nightly.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SolcInput, SolcOutput } from "@openzeppelin/upgrades-core";
import { LayoutIntegrityError, LayoutUnavailableError } from "./errors.js";

const BINARIES_URL = "https://binaries.soliditylang.org";

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
// Validated before use: the version becomes part of a path that gets executed.
const SOLC_VERSION =
  /^\d+\.\d+\.\d+(?:-nightly\.\d+\.\d+\.\d+|-pre\.\d+)?(?:\+commit\.[0-9a-f]+)?$/;
const RELEASE_LONG_VERSION = /^\d+\.\d+\.\d+\+commit\.[0-9a-f]+$/;

export interface SolcRunner {
  /**
   * Resolved, e.g. `0.8.24+commit.e11b9ed9` even when asked for `0.8.24`. With
   * `resolvePath`, the version as passed.
   */
  longVersion: string;
  path: string;
  compile(input: SolcInput): Promise<SolcOutput>;
}

export interface SolcOptions {
  /** Where downloaded compilers are kept. Defaults to `<os cache>/slotdiff/compilers`. */
  cacheDir?: string;
  /** Explicit binary for a version (as passed to `getSolc`), e.g. on platforms with no official native build. */
  resolvePath?: (version: string) => string | undefined;
}

type FetchBinary = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export async function getSolc(
  version: string,
  options: SolcOptions = {},
  fetchImpl: FetchBinary = fetch,
): Promise<SolcRunner> {
  const { path, longVersion } = await locateSolc(version, options, fetchImpl);
  return { longVersion, path, compile: (input) => runSolc(path, input) };
}

const downloads = new Map<string, Promise<void>>();

interface LocatedSolc {
  path: string;
  longVersion: string;
}

interface SolcBuild {
  path: string;
  longVersion: string;
  sha256: string;
}

async function locateSolc(
  version: string,
  options: SolcOptions,
  fetchImpl: FetchBinary,
): Promise<LocatedSolc> {
  if (!SOLC_VERSION.test(version)) {
    throw new LayoutUnavailableError(`"${version}" is not a solc version.`);
  }
  const explicit = options.resolvePath?.(version);
  if (explicit !== undefined) return { path: explicit, longVersion: version };

  const platform = nativePlatform();
  const cacheDir = options.cacheDir ?? join(osCacheDir(), "slotdiff", "compilers");
  // Hardhat's cache follows env-paths, which adds a `Cache` folder on Windows.
  const hardhatCache =
    process.platform === "win32"
      ? join(osCacheDir(), "hardhat-nodejs", "Cache")
      : join(osCacheDir(), "hardhat-nodejs");
  const dirs = [
    join(cacheDir, platform),
    join(hardhatCache, "compilers-v3", platform),
    join(hardhatCache, "compilers-v2", platform),
  ];
  for (const dir of dirs) {
    const cached = await findCached(dir, platform, version);
    if (cached !== undefined) return cached;
  }

  const build = await findBuild(platform, version, fetchImpl);
  const dest = join(cacheDir, platform, binaryName(platform, build.longVersion));
  // Concurrent callers (one per proxy, say) share one download per binary.
  let pending = downloads.get(dest);
  if (pending === undefined) {
    pending = download(platform, build, dest, fetchImpl).finally(() => downloads.delete(dest));
    downloads.set(dest, pending);
  }
  await pending;
  return { path: dest, longVersion: build.longVersion };
}

function binaryName(platform: string, longVersion: string): string {
  return `solc-${platform}-v${longVersion}${platform === "windows-amd64" ? ".exe" : ""}`;
}

async function findCached(
  dir: string,
  platform: string,
  version: string,
): Promise<LocatedSolc | undefined> {
  if (!RELEASE_VERSION.test(version)) {
    const path = join(dir, binaryName(platform, version));
    return (await isExecutable(path)) ? { path, longVersion: version } : undefined;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  // Only finished release binaries of this version: no nightlies (`0.8.24-nightly...`),
  // no longer versions (`0.8.240`), no in-progress `.tmp` downloads.
  const prefix = `solc-${platform}-v`;
  const ext = platform === "windows-amd64" ? ".exe" : "";
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
    const longVersion = name.slice(prefix.length, name.length - ext.length);
    if (!RELEASE_LONG_VERSION.test(longVersion) || !longVersion.startsWith(`${version}+`)) continue;
    const path = join(dir, name);
    if (await isExecutable(path)) return { path, longVersion };
  }
  return undefined;
}

async function findBuild(
  platform: string,
  version: string,
  fetchImpl: FetchBinary,
): Promise<SolcBuild> {
  // Failing to obtain a compiler means the layout cannot be rebuilt, not
  // that it is wrong; only a checksum mismatch is an integrity problem.
  const listRes = await fetchOrUnavailable(fetchImpl, `${BINARIES_URL}/${platform}/list.json`);
  if (!listRes.ok) {
    throw new LayoutUnavailableError(
      `Could not fetch the solc build list (HTTP ${listRes.status}).`,
    );
  }
  const list = (await listRes.json()) as { builds: SolcBuild[] };
  const build = RELEASE_VERSION.test(version)
    ? // A nightly reads `0.8.24-nightly...`, so only the release starts with `0.8.24+`.
      list.builds.find((b) => b.longVersion.startsWith(`${version}+`))
    : list.builds.find((b) => b.longVersion === version);
  if (build === undefined) {
    throw new LayoutUnavailableError(`solc ${version} has no native ${platform} build.`);
  }
  // Old Windows releases (up to 0.7.1) ship as zip archives, not executables.
  if (build.path.endsWith(".zip")) {
    throw new LayoutUnavailableError(
      `solc ${build.longVersion} for ${platform} ships as a zip archive; pass a compiler via solc.resolvePath.`,
    );
  }
  return build;
}

async function download(
  platform: string,
  build: SolcBuild,
  dest: string,
  fetchImpl: FetchBinary,
): Promise<void> {
  const binRes = await fetchOrUnavailable(fetchImpl, `${BINARIES_URL}/${platform}/${build.path}`);
  if (!binRes.ok) {
    throw new LayoutUnavailableError(
      `Could not download solc ${build.longVersion} (HTTP ${binRes.status}).`,
    );
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (`0x${actual}` !== build.sha256.toLowerCase()) {
    throw new LayoutIntegrityError(
      `solc ${build.longVersion} download failed its sha256 check; refusing to run it.`,
    );
  }

  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes);
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
}

function runSolc(path: string, input: SolcInput): Promise<SolcOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["--standard-json"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    // A compiler that exits before reading all input closes the pipe; reject
    // instead of crashing the process with an unhandled EPIPE.
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`solc exited with code ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString()) as SolcOutput);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function nativePlatform(): string {
  const { platform, arch } = process;
  if (platform === "darwin") return "macosx-amd64"; // universal binaries for recent versions
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw new LayoutUnavailableError(
    `No official native solc build for ${platform}/${arch}; pass a compiler path via solc.resolvePath.`,
  );
}

async function fetchOrUnavailable(fetchImpl: FetchBinary, url: string) {
  try {
    return await fetchImpl(url);
  } catch (e) {
    throw new LayoutUnavailableError(`Could not reach ${BINARIES_URL}: ${(e as Error).message}`);
  }
}

function osCacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
