/**
 * Rebuilds the storage layout of deployed code from its verified source, and
 * proves the source is the deployed code before trusting the layout.
 *
 * The layout comes out of the same oz-core pipeline the compile hook runs for
 * the local build (full compile, namespaced second pass, `validate()`,
 * `getStorageLayout`), so both sides of a comparison are extracted identically.
 */

import {
  getErrors,
  getStorageLayout,
  hashBytecode,
  inferProxyKind,
  isNamespaceSupported,
  makeNamespacedInput,
  solcInputOutputDecoder,
  trySanitizeNatSpec,
  UpgradeableContractErrorReport,
  validate,
  type ProxyDeployment,
  type SolcInput,
  type SolcOutput,
  type StorageLayout,
  type ValidationRunData,
} from "@openzeppelin/upgrades-core";
// Not exported from the package index; the package has no exports map.
import { errorKinds, type ValidationError } from "@openzeppelin/upgrades-core/dist/validate/run.js";
import { compareDeployedBytecode, isProvingMatch, type ProvingMatch } from "./bytecode.js";
import { namespaceSlots, type NamespaceSlot } from "./erc7201.js";
import { IncompleteBuildError, LayoutIntegrityError, printable } from "./errors.js";
import type { VerifiedSource } from "./explorer.js";
import type { SolcRunner } from "./solc.js";

export interface ReconstructedLayout extends SourceAnalysis {
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  compiler: string;
  bytecodeMatch: ProvingMatch;
}

// validate() reads evm.bytecode for every contract, so codegen is requested
// for all of them. A verified input holds only the target's dependency graph.
const FULL_SELECTION = {
  "*": {
    "*": [
      "storageLayout",
      "evm.bytecode.object",
      "evm.bytecode.linkReferences",
      "evm.deployedBytecode.object",
      "evm.deployedBytecode.immutableReferences",
      "metadata",
    ],
    "": ["ast"],
  },
};

// The namespaced pass only needs layouts and ASTs; skipping codegen keeps it cheap.
const LAYOUT_SELECTION = { "*": { "*": ["storageLayout"], "": ["ast"] } };

export async function reconstructLayout(
  source: VerifiedSource,
  solc: SolcRunner,
  onchainCode: string,
): Promise<ReconstructedLayout> {
  const input = withOutputSelection(source.input, FULL_SELECTION);
  const output = await compileOrThrow(solc, input, "verified source");

  const { contract, bytecodeMatch } = proveDeployedCode(
    output,
    source.contractName,
    onchainCode,
    embedsSourceHash(source.input),
  );

  return {
    contract,
    compiler: source.solcLongVersion,
    bytecodeMatch,
    ...(await analyzeBuild(input, output, solc)).contract(contract),
  };
}

/**
 * The layout of `contract` (`source.sol:Name`) in `input`, with no bytecode
 * proof. Only for sources whose provenance is already known, such as a
 * project's own build-info.
 */
export async function layoutFromSource(
  input: SolcInput,
  solc: SolcRunner,
  contract: string,
): Promise<StorageLayout> {
  return (await analyzeSource(input, solc, contract)).layout;
}

export type ProxyKind = ProxyDeployment["kind"];

/**
 * OpenZeppelin's safety error kinds, without the deprecated struct-definition
 * and enum-definition, which the check never reports.
 */
export type SafetyErrorKind = Exclude<
  ValidationError["kind"],
  "struct-definition" | "enum-definition"
>;

export const SAFETY_ERROR_KINDS: readonly SafetyErrorKind[] = errorKinds.filter(
  (k): k is SafetyErrorKind => k !== "struct-definition" && k !== "enum-definition",
);

export interface SafetyError {
  /** OpenZeppelin's error kind, such as `constructor`. */
  kind: SafetyErrorKind;
  /** Where, as `file.sol:line`. */
  src: string;
}

export interface SafetyOptions {
  /**
   * The proxy being upgraded; only `uups` requires an `upgradeToAndCall`.
   * Required: the new contract's own `kind` would let a UUPS implementation
   * that lost its upgrade function pass.
   */
  kind: ProxyKind;
  /** Error kinds to accept anyway (OZ's `unsafeAllow`). Prefer NatSpec exceptions in the source. */
  unsafeAllow?: SafetyErrorKind[];
}

export interface SafetyReport {
  ok: boolean;
  errors: SafetyError[];
  /** OpenZeppelin's description of each error; `color` (default true) adds terminal colors. */
  explain(color?: boolean): string;
}

export interface SourceAnalysis {
  layout: StorageLayout;
  /** `uups` when the contract has `upgradeTo` or `upgradeToAndCall`, else `transparent`. */
  kind: Exclude<ProxyKind, "beacon">;
  /**
   * The slot each ERC-7201 namespace really uses, read from the code
   * (`$.slot := LOCATION`); OpenZeppelin trusts the annotation alone.
   */
  namespaces: NamespaceSlot[];
  /**
   * OpenZeppelin's safety check (constructors, `selfdestruct`,
   * `delegatecall`, initial values, immutables, initializers), honoring
   * `@custom:oz-upgrades-unsafe-allow` in the source.
   */
  safety(options: SafetyOptions): SafetyReport;
}

/** `layoutFromSource` plus OpenZeppelin's safety check, from one compile. */
export async function analyzeSource(
  input: SolcInput,
  solc: BuildCompiler,
  contract: string,
): Promise<SourceAnalysis> {
  const selected = withOutputSelection(input, FULL_SELECTION);
  const output = await compileOrThrow(solc, selected, "source");
  return (await analyzeBuild(selected, output, solc)).contract(contract);
}

/** The compiler for OpenZeppelin's namespaced pass: a `SolcRunner`, or a build tool's. */
export type BuildCompiler = Pick<SolcRunner, "longVersion" | "compile">;

export interface BuildAnalysis {
  /** The analysis of one contract in the build, `source.sol:Name`. */
  contract(contract: string): SourceAnalysis;
}

/**
 * `analyzeSource` for a build you already compiled, such as a build tool's,
 * without compiling it again: one namespaced pass and one validation serve
 * every contract in it. `output` must hold every source's `ast` and, for each
 * contract, its `metadata`, `storageLayout` (an interface or library may lack
 * it) and `evm.bytecode` (`object`, `linkReferences`); without them it throws
 * `IncompleteBuildError`. The metadata proves `output` was compiled from
 * `input`'s sources by `compiler`'s version (not with its settings).
 */
export async function analyzeBuild(
  input: SolcInput,
  output: SolcOutput,
  compiler: BuildCompiler,
): Promise<BuildAnalysis> {
  checkBuild(input, output, compiler.longVersion);
  const runData = await validateBuild(input, output, compiler);
  return { contract: (contract) => analyzeContract(runData, output, contract) };
}

interface AstNode {
  nodeType?: string;
  name?: unknown;
  contractKind?: unknown;
}

interface CompiledContract {
  metadata?: unknown;
  storageLayout?: unknown;
  evm?: { bytecode?: { object?: unknown; linkReferences?: unknown } };
}

/**
 * The analysis reads layouts from `output` and edits `input` at the offsets in
 * `output`'s ASTs, so the two must be one build, complete: an output from other
 * sources could pass a changed layout, and one without an AST would leave every
 * namespace unassigned, compared by annotation alone. Anything else is refused.
 */
function checkBuild(input: SolcInput, output: SolcOutput, longVersion: string): void {
  if (output.sources === undefined && Object.hasOwn(output, "_format")) {
    throw new Error(
      "The compiler output is wrapped in a build info file; pass its output field " +
        "(Hardhat 3 writes { _format, output } to <id>.output.json).",
    );
  }
  const paths = Object.keys(input.sources);
  const outputPaths = Object.keys(output.sources ?? {});
  if (
    paths.length !== outputPaths.length ||
    paths.some((path) => !Object.hasOwn(output.sources, path))
  ) {
    throw new Error("The compiler output does not hold the same sources as the input.");
  }
  for (const path of paths) {
    if (typeof (input.sources[path] as { content?: unknown }).content !== "string") {
      throw new Error(`The compiler input has no content for ${path}.`);
    }
    const ast = output.sources[path].ast as { nodes?: AstNode[] } | undefined;
    if (ast === undefined) {
      throw new IncompleteBuildError(
        `The compiler output has no ast for ${path}; it needs every source's ast.`,
      );
    }
    for (const node of ast.nodes ?? []) {
      if (node.nodeType !== "ContractDefinition") continue;
      const name = `${path}:${String(node.name)}`;
      const c = output.contracts?.[path]?.[String(node.name)] as CompiledContract | undefined;
      if (c === undefined)
        throw new IncompleteBuildError(`The compiler output has no contract output for ${name}.`);
      // Neither can hold state, and some tools (Foundry) leave their layout out.
      const stateless = node.contractKind === "interface" || node.contractKind === "library";
      if (
        typeof c.metadata !== "string" ||
        (c.storageLayout === undefined && !stateless) ||
        typeof c.evm?.bytecode?.object !== "string" ||
        typeof c.evm.bytecode.linkReferences !== "object"
      ) {
        throw new IncompleteBuildError(
          `The compiler output for ${name} lacks metadata, storageLayout or evm.bytecode ` +
            `(object, linkReferences); compile with them in outputSelection.`,
        );
      }
      proveSameBuild(input, path, name, c.metadata, longVersion);
    }
  }
}

function proveSameBuild(
  input: SolcInput,
  path: string,
  name: string,
  metadata: string,
  longVersion: string,
) {
  let parsed: {
    compiler?: { version?: unknown };
    sources?: Record<string, { keccak256?: unknown }>;
  };
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new LayoutIntegrityError(`The metadata for ${name} is not JSON.`);
  }
  const [version, commit] = String(parsed.compiler?.version).split("+");
  const [wanted, wantedCommit] = longVersion.split("+");
  if (
    version !== wanted ||
    (commit !== undefined && wantedCommit !== undefined && commit !== wantedCommit)
  ) {
    throw new LayoutIntegrityError(
      `${name} was compiled by solc ${String(parsed.compiler?.version)}, not ${longVersion}.`,
    );
  }
  // Its own source at least: metadata that lists none would prove nothing.
  const sources: Record<string, { keccak256?: unknown }> = { [path]: {}, ...parsed.sources };
  for (const [source, { keccak256 }] of Object.entries(sources)) {
    const content = (input.sources[source] as { content?: string } | undefined)?.content;
    const hash =
      content === undefined ? undefined : "0x" + hashBytecode(Buffer.from(content).toString("hex"));
    if (hash !== keccak256) {
      throw new LayoutIntegrityError(
        `The compiler output for ${name} was not compiled from this input (${source} differs).`,
      );
    }
  }
}

function analyzeContract(
  runData: ValidationRunData,
  output: SolcOutput,
  contract: string,
): SourceAnalysis {
  const colon = contract.lastIndexOf(":");
  if (output.contracts?.[contract.slice(0, colon)]?.[contract.slice(colon + 1)] === undefined) {
    throw new Error(
      `${contract} is not in the compiler input. Name it as source.sol:Contract, with the ` +
        `source path exactly as the input has it (Hardhat 3 starts it with project/).`,
    );
  }
  const version = runData[contract]?.version;
  if (version === undefined) {
    throw new LayoutIntegrityError(
      `${contract} compiled to no bytecode (an abstract contract or interface?); ` +
        `cannot derive its layout.`,
    );
  }
  // OZ looks the contract up by bytecode version and takes the first match, so
  // two contracts with identical code (possible without a source hash) could
  // swap layouts or safety errors. Listing the target first makes every lookup land on it.
  const data: ValidationRunData = { [contract]: runData[contract], ...runData };
  // A copy: OpenZeppelin's layout points into the run data that every call shares.
  const layout = structuredClone(getStorageLayout(data, version));
  return {
    layout,
    // Typed as any ProxyKind, but only ever uups or transparent.
    kind: inferProxyKind(data, version) as SourceAnalysis["kind"],
    namespaces: namespaceSlots(output, contract, Object.keys(layout.namespaces ?? {})),
    safety({ kind, unsafeAllow = [] }) {
      // OpenZeppelin ignores a kind it does not know, so a typo would accept nothing silently.
      const unknown = unsafeAllow.find((k) => !SAFETY_ERROR_KINDS.includes(k));
      if (unknown !== undefined) {
        throw new Error(
          `Unknown unsafeAllow error kind "${String(unknown)}". Known: ${SAFETY_ERROR_KINDS.join(", ")}.`,
        );
      }
      // A copy: OpenZeppelin appends to the array it is given.
      const opts = { kind, unsafeAllow: [...unsafeAllow] };
      // The deprecated kinds are never reported, so every error has a SafetyErrorKind.
      const errors = getErrors(data, version, opts) as Array<ValidationError & SafetyError>;
      return {
        ok: errors.length === 0,
        errors,
        explain: (color?: boolean) => new UpgradeableContractErrorReport(errors).explain(color),
      };
    },
  };
}

async function validateBuild(
  input: SolcInput,
  output: SolcOutput,
  compiler: BuildCompiler,
): Promise<ValidationRunData> {
  const solcVersion = compiler.longVersion.split("+")[0];

  let namespacedOutput: SolcOutput | undefined;
  if (isNamespaceSupported(solcVersion)) {
    let namespacedInput = makeNamespacedInput(input, output, solcVersion);
    namespacedInput = await trySanitizeNatSpec(namespacedInput, solcVersion);
    namespacedOutput = await compileOrThrow(
      compiler,
      withOutputSelection(namespacedInput, LAYOUT_SELECTION),
      "namespaced pass",
    );
  }

  return validate(
    output,
    solcInputOutputDecoder(input, output),
    solcVersion,
    input,
    namespacedOutput,
  );
}

/**
 * Finds the compiled contract that matches the deployed code. The verified
 * name narrows the search, but two files may define a contract with the same
 * name, so the bytecode decides, and the strongest match wins. Only a proving
 * match is accepted: `metadata-only` can hide a different storage layout.
 */
function proveDeployedCode(
  output: SolcOutput,
  contractName: string,
  onchainCode: string,
  hashed: boolean,
): { contract: string; bytecodeMatch: ProvingMatch } {
  let candidates = 0;
  let best: { contract: string; bytecodeMatch: ProvingMatch } | undefined;
  let weak: "metadata-only" | "code-only" | undefined;
  for (const [sourcePath, contracts] of Object.entries(output.contracts ?? {})) {
    const compiled = contracts[contractName] as
      | {
          evm?: {
            deployedBytecode?: {
              object?: string;
              immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
            };
          };
        }
      | undefined;
    const deployed = compiled?.evm?.deployedBytecode;
    if (deployed?.object === undefined) continue;
    candidates++;
    const compared = compareDeployedBytecode(
      onchainCode,
      deployed.object,
      deployed.immutableReferences,
    );
    const match = !hashed && isProvingMatch(compared) ? "code-only" : compared;
    if (match === "metadata-only" || match === "code-only") weak ??= match;
    if (!isProvingMatch(match)) continue;
    if (best === undefined || (match === "exact" && best.bytecodeMatch !== "exact")) {
      best = { contract: `${sourcePath}:${contractName}`, bytecodeMatch: match };
    }
  }
  if (best !== undefined) return best;

  if (candidates === 0) {
    throw new LayoutIntegrityError(`Verified source has no contract named "${contractName}".`);
  }
  // Neither weak match proves the layout: unread variables and gap sizes never reach the bytecode.
  throw new LayoutIntegrityError(
    weak === "metadata-only"
      ? `Verified source for "${contractName}" matches the deployed code only after stripping ` +
          `metadata, so the compiler input differed. That does not prove the storage layout ` +
          `(unread variables and gap sizes never reach the bytecode). Refusing to trust it.`
      : weak === "code-only"
        ? `Verified source for "${contractName}" compiles to the deployed code, but the build ` +
          `embeds no source hash (bytecodeHash "none" or appendCBOR false), so the code does ` +
          `not prove the source or its storage layout. Refusing to trust it.`
        : `Verified source for "${contractName}" does not compile to the deployed code, ` +
          `even with immutables masked. Refusing to trust its layout.`,
  );
}

/**
 * Whether the verified settings embed a metadata hash. The bytecode check alone
 * can be fooled: without CBOR (`appendCBOR: false`) the code can end in a data
 * literal shaped like solc's metadata. The settings cannot lie, since the code
 * only matches when compiled with the settings that were really used.
 */
function embedsSourceHash(input: SolcInput): boolean {
  const metadata = (
    input.settings as { metadata?: { appendCBOR?: boolean; bytecodeHash?: string } }
  ).metadata;
  return metadata?.appendCBOR !== false && metadata?.bytecodeHash !== "none";
}

async function compileOrThrow(
  solc: BuildCompiler,
  input: SolcInput,
  what: string,
): Promise<SolcOutput> {
  const output = await solc.compile(input);
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new LayoutIntegrityError(
      `solc ${solc.longVersion} failed to compile the ${what}: ${printable(String(errors[0].formattedMessage))}`,
    );
  }
  return output;
}

// Only solc's standard-json keys: build tools add their own (Foundry's build-info
// input carries `version`, `allowPaths`, `basePath`, `includePaths`), and solc
// rejects any key it does not know.
function withOutputSelection(input: SolcInput, outputSelection: unknown): SolcInput {
  // upgrades-core's SolcInput type omits `language`, which standard json requires.
  const { language } = input as SolcInput & { language?: string };
  return {
    language,
    sources: input.sources,
    settings: { ...input.settings, outputSelection },
  } as SolcInput;
}
