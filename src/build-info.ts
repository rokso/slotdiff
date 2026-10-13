/**
 * Reads a project's own build info: Foundry, Hardhat 2 and Hardhat 3.
 *
 * The build is chosen by content, never by modification time or file count.
 * Foundry keeps every build-info file it ever wrote, so after a few edits
 * several hold the target, most of them describing older sources. Only a build
 * whose sources still match the files on disk is used.
 */

import type { SolcInput } from "@openzeppelin/upgrades-core";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ImmutableReferences } from "./bytecode.js";

export interface BuildInfoOptions {
  /**
   * One build-info file to use as is, relative to the project root. Its
   * sources are not compared with the files on disk, so it may come from
   * another checkout, such as a CI artifact.
   */
  file?: string;
}

export interface BuildInfoContract {
  /** The build-info file it was read from. */
  file: string;
  /**
   * Fully qualified name as solc saw it, `source.sol:Name`. Hardhat 3 prefixes
   * project sources with `project/`.
   */
  contract: string;
  /** As recorded: a long version, or a release version for Foundry. Both work with `getSolc`. */
  solcVersion: string;
  /**
   * The compiler input, reduced to the target and what it imports, so that a
   * layout compiles only those sources rather than the whole project.
   */
  input: SolcInput;
  /** Absent when the build info holds no compiler output. */
  deployedBytecode?: string;
  immutableReferences?: ImmutableReferences;
}

// Foundry, then Hardhat.
const DIRS = ["out/build-info", "artifacts/build-info"];

const NO_INPUT_HINT =
  " Foundry writes the compiler input only with `build_info = true` in foundry.toml or " +
  "`forge build --build-info`.";

interface RawBuildInfo {
  _format?: string;
  solcLongVersion?: string;
  input?: SolcInput & { sources?: Record<string, { content?: string }> };
  output?: {
    contracts?: Record<string, Record<string, CompiledContract>>;
    sources?: Record<
      string,
      { ast?: { nodes?: Array<{ nodeType?: string; absolutePath?: string }> } }
    >;
  };
  userSourceNameMap?: Record<string, string>;
  source_id_to_path?: unknown;
}

interface CompiledContract {
  evm?: { deployedBytecode?: { object?: string; immutableReferences?: ImmutableReferences } };
}

interface Candidate {
  file: string;
  info: RawBuildInfo;
  contract: string;
}

/**
 * Finds `contract` in the build info under `root` and returns what a layout
 * or a bytecode proof needs. `contract` is `path/File.sol:Name`, with the path
 * as written in the project (Hardhat 3's `project/` prefix is optional), or a
 * bare `Name` when only one contract has it.
 */
export async function findBuildInfo(
  root: string,
  contract: string,
  options: BuildInfoOptions = {},
): Promise<BuildInfoContract> {
  const target = parseTarget(contract);
  if (target.path !== undefined && isAbsolute(target.path)) {
    target.path = relative(root, target.path);
  }

  if (options.file !== undefined) {
    const file = resolve(root, options.file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      throw new Error(`Cannot read ${options.file} (${(e as NodeJS.ErrnoException).code}).`, {
        cause: e,
      });
    }
    const info = await readBuildInfo(file, text);
    if (info === undefined)
      throw new Error(`${options.file} holds no compiler input.${NO_INPUT_HINT}`);
    const matches = findContract(info, target);
    if (matches.length === 0) throw new Error(`${options.file} has no contract ${contract}.`);
    if (matches.length > 1) throw ambiguousName(contract, matches);
    return toResult({ file, info, contract: matches[0] });
  }

  const files = await listBuildInfoFiles(root);
  if (files.length === 0) {
    const isDir = await stat(root).then(
      (st) => st.isDirectory(),
      () => false,
    );
    if (!isDir) throw new Error(`The project root ${root} is not a directory.`);
    throw new Error(
      `No build info found in ${DIRS.join(" or ")} under ${root}. Run from the project root ` +
        `(or pass its path as the root), after a build.${NO_INPUT_HINT}`,
    );
  }

  const holding: Candidate[] = [];
  let withoutInput = false;
  for (const file of files) {
    // Cheap text check first: build-info files can be large, and most do not hold the target.
    const text = await readFile(file, "utf8");
    if (target.path !== undefined && !text.includes(`${target.path}"`)) continue;
    const info = await readBuildInfo(file, text);
    if (info === undefined) {
      withoutInput = true;
      continue;
    }
    for (const name of findContract(info, target)) holding.push({ file, info, contract: name });
  }
  if (holding.length === 0) {
    throw new Error(
      `No build info holds ${contract}. ` +
        (withoutInput
          ? `Some hold no compiler input.${NO_INPUT_HINT}`
          : "Check the name (it is case-sensitive) and give the source path as the compiler " +
            "saw it (for a remapped import, the path under lib/), or just the contract name. " +
            "Or build first."),
    );
  }

  // A build is fresh when the target's file exists and nothing it imports has changed.
  const fresh: Candidate[] = [];
  const stale: Array<{ candidate: Candidate; target: string | undefined }> = [];
  for (const candidate of holding) {
    const disk = await checkDisk(root, candidate);
    if (disk === "gone") continue;
    if (disk.fresh) fresh.push(candidate);
    else stale.push({ candidate, target: disk.target });
  }

  // A bare name is ambiguous across every build that holds it, not only the
  // fresh ones: an incremental build holds just the files it recompiled, so the
  // freshest build can miss a second definition. A stale definition counts only
  // while its file still declares the name (it may have been renamed since).
  const name = target.name.replace(/\$/g, "\\$");
  const declares = new RegExp(`\\b(?:contract|interface|library)\\s+${name}(?![\\w$])`);
  const present = [
    ...fresh,
    ...stale
      .filter(({ target }) => target === undefined || declares.test(target))
      .map(({ candidate }) => candidate),
  ];
  const names = [...new Set(present.map((c) => c.contract))];
  if (names.length > 1) throw ambiguousName(contract, names);

  if (fresh.length === 0) {
    throw new Error(
      stale.length > 0
        ? `Every build info holding ${contract} is older than the sources on disk. Build again.`
        : `${contract} is no longer on disk (moved or deleted). Build again.`,
    );
  }

  // Several fresh builds of the same sources are interchangeable only when the
  // compiler and its settings agree (Foundry profiles can differ in both).
  const byBuild = new Map<string, Candidate>();
  for (const candidate of fresh.sort((a, b) => a.file.localeCompare(b.file))) {
    const key = buildKey(candidate.info);
    if (!byBuild.has(key)) byBuild.set(key, candidate);
  }
  if (byBuild.size > 1) {
    const files = [...byBuild.values()].map((c) => relative(root, c.file));
    throw new Error(
      `${contract} was built with different compilers or settings in ${files.join(", ")} ` +
        `(a project with several solc versions compiles shared files once per version). ` +
        `Pick one with the \`file\` option (\`--build-info\` on the command line); ` +
        `\`forge clean\` drops leftover builds.`,
    );
  }
  return toResult([...byBuild.values()][0]);
}

interface Target {
  /** Source path as given, without Hardhat 3's `project/` prefix. */
  path?: string;
  name: string;
}

function parseTarget(contract: string): Target {
  const colon = contract.lastIndexOf(":");
  const name = contract.slice(colon + 1);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    // Not quoted: a URL passed here by mistake can carry an API key.
    throw new Error("Expected a contract name or `path/File.sol:Name`.");
  }
  if (colon === -1) return { name };
  const path = contract.slice(0, colon).replace(/^\.\//, "");
  return { path: path.replace(/^project\//, ""), name };
}

async function listBuildInfoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of DIRS) {
    let entries: string[];
    try {
      entries = await readdir(resolve(root, dir));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const entry of entries.sort()) {
      // Hardhat 3 keeps the compiler output next to the build info, in `<id>.output.json`.
      if (entry.endsWith(".json") && !entry.endsWith(".output.json")) {
        files.push(join(resolve(root, dir), entry));
      }
    }
  }
  return files;
}

/**
 * Undefined for a file with no compiler input: Foundry writes one per build
 * (only `id` and `source_id_to_path`) unless asked for full build info.
 */
async function readBuildInfo(file: string, text: string): Promise<RawBuildInfo | undefined> {
  let info: RawBuildInfo;
  try {
    info = JSON.parse(text) as RawBuildInfo;
  } catch (e) {
    throw new Error(`${file} is not JSON: ${(e as Error).message}`, { cause: e });
  }
  if (info?.input === undefined && info?.source_id_to_path !== undefined) return undefined;
  if (
    typeof info?.solcLongVersion !== "string" ||
    typeof info.input?.sources !== "object" ||
    info.input.sources === null
  ) {
    throw new Error(`${file} is not a build-info file (no solcLongVersion or input sources).`);
  }
  if (info.output === undefined) {
    const outputFile = file.replace(/\.json$/, ".output.json");
    try {
      info.output = (JSON.parse(await readFile(outputFile, "utf8")) as RawBuildInfo).output;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot read ${outputFile}: ${(e as Error).message}`, { cause: e });
      }
    }
  }
  return info;
}

// Fully qualified names in `info` that match the target.
function findContract(info: RawBuildInfo, target: Target): string[] {
  const sources = Object.keys(info.input!.sources);
  if (target.path !== undefined) {
    const path = target.path;
    const source = sources.find((s) => s === path || s === `project/${path}`);
    if (source === undefined) return [];
    const compiled = info.output?.contracts?.[source];
    // Without output the name cannot be checked here; solc checks it when the layout is built.
    if (compiled !== undefined && !Object.hasOwn(compiled, target.name)) return [];
    return [`${source}:${target.name}`];
  }
  if (info.output?.contracts === undefined) return [];
  return Object.entries(info.output.contracts)
    .filter(([, contracts]) => Object.hasOwn(contracts, target.name))
    .map(([source]) => `${source}:${target.name}`);
}

/**
 * Compares the target and every source it imports, directly or not, with the
 * disk. A changed base contract changes the target's layout; a changed
 * unrelated file does not, and must not make a build stale: an incremental
 * build holds only the files it recompiled, so the build that holds the target
 * is often older than files the target never imports. `gone` when the target's
 * file no longer exists; a dependency not found on disk (hoisted node_modules,
 * say) is not checked. `target` is the target's text on disk, when found.
 */
async function checkDisk(
  root: string,
  { info, contract }: Candidate,
): Promise<"gone" | { fresh: boolean; target: string | undefined }> {
  const targetSource = sourceOf(contract);
  let target: string | undefined;
  let fresh = true;
  // The target comes first.
  for (const source of dependencies(info, targetSource)) {
    const onDisk = await readSource(root, info, source);
    if (source === targetSource) {
      if (onDisk === null) return "gone";
      target = onDisk;
    }
    const content = info.input!.sources[source]?.content;
    if (typeof onDisk === "string" && typeof content === "string" && onDisk !== content) {
      fresh = false;
    }
  }
  return { fresh, target };
}

/**
 * `source` and everything it imports, from the import directives in the
 * output's ASTs. Without them, every source in the build (the cautious answer).
 */
function dependencies(info: RawBuildInfo, source: string): string[] {
  // The target first, as checkDisk expects.
  const all = [source, ...Object.keys(info.input!.sources).filter((s) => s !== source)];
  const asts = info.output?.sources;
  const seen = new Set([source]);
  const queue = [source];
  while (queue.length > 0) {
    const nodes = asts?.[queue.pop()!]?.ast?.nodes;
    if (nodes === undefined) return all;
    for (const node of nodes) {
      const imported = node.nodeType === "ImportDirective" ? node.absolutePath : undefined;
      if (imported !== undefined && !seen.has(imported)) {
        seen.add(imported);
        queue.push(imported);
      }
    }
  }
  return [...seen];
}

/**
 * The file on disk behind a build's source name: undefined when it cannot be
 * located by name (Hardhat 3's versioned `npm/` paths), null when it should be
 * there and is not.
 */
async function readSource(
  root: string,
  info: RawBuildInfo,
  source: string,
): Promise<string | null | undefined> {
  const user = Object.entries(info.userSourceNameMap ?? {}).find(([, s]) => s === source)?.[0];
  if (user === undefined && source.startsWith("npm/")) return undefined;
  const names =
    user !== undefined
      ? [user]
      : [source, ...(source.startsWith("project/") ? [source.slice("project/".length)] : [])];
  const paths = names.flatMap((name) => [resolve(root, name), resolve(root, "node_modules", name)]);
  return (await readFirst(paths)) ?? null;
}

async function readFirst(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
  }
  return undefined;
}

function buildKey(info: RawBuildInfo): string {
  const settings = { ...(info.input!.settings as Record<string, unknown> | undefined) };
  delete settings.outputSelection;
  return JSON.stringify([info.solcLongVersion, settings]);
}

function ambiguousName(contract: string, names: string[]): Error {
  return new Error(`${contract} is ambiguous: ${names.join(", ")}. Use \`path/File.sol:Name\`.`);
}

function sourceOf(contract: string): string {
  return contract.slice(0, contract.lastIndexOf(":"));
}

function toResult({ file, info, contract }: Candidate): BuildInfoContract {
  const source = sourceOf(contract);
  const deployed =
    info.output?.contracts?.[source]?.[contract.slice(source.length + 1)]?.evm?.deployedBytecode;
  const sources = info.input!.sources;
  return {
    file,
    contract,
    solcVersion: info.solcLongVersion!,
    input: {
      ...info.input!,
      sources: Object.fromEntries(dependencies(info, source).map((s) => [s, sources[s]])),
    },
    deployedBytecode: deployed?.object,
    immutableReferences: deployed?.immutableReferences,
  };
}
