/**
 * Rebuilds the storage layout of deployed code from its verified source, and
 * proves the source is the deployed code before trusting the layout.
 *
 * The layout comes out of the same oz-core pipeline the compile hook runs for
 * the local build (full compile, namespaced second pass, `validate()`,
 * `getStorageLayout`), so both sides of a comparison are extracted identically.
 */

import {
  getStorageLayout,
  isNamespaceSupported,
  makeNamespacedInput,
  solcInputOutputDecoder,
  trySanitizeNatSpec,
  validate,
  type SolcInput,
  type SolcOutput,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";
import { compareDeployedBytecode, isProvingMatch, type ProvingMatch } from "./bytecode.js";
import { LayoutIntegrityError } from "./errors.js";
import type { VerifiedSource } from "./explorer.js";
import type { SolcRunner } from "./solc.js";

export interface ReconstructedLayout {
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  compiler: string;
  bytecodeMatch: ProvingMatch;
  layout: StorageLayout;
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
    layout: await extractLayout(input, output, solc, contract),
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
  const selected = withOutputSelection(input, FULL_SELECTION);
  const output = await compileOrThrow(solc, selected, "source");
  return extractLayout(selected, output, solc, contract);
}

async function extractLayout(
  input: SolcInput,
  output: SolcOutput,
  solc: SolcRunner,
  contract: string,
): Promise<StorageLayout> {
  const solcVersion = solc.longVersion.split("+")[0];

  let namespacedOutput: SolcOutput | undefined;
  if (isNamespaceSupported(solcVersion)) {
    let namespacedInput = makeNamespacedInput(input, output, solcVersion);
    namespacedInput = await trySanitizeNatSpec(namespacedInput, solcVersion);
    namespacedOutput = await compileOrThrow(
      solc,
      withOutputSelection(namespacedInput, LAYOUT_SELECTION),
      "namespaced pass",
    );
  }

  const runData = validate(
    output,
    solcInputOutputDecoder(input, output),
    solcVersion,
    input,
    namespacedOutput,
  );
  const version = runData[contract]?.version;
  if (version === undefined) {
    throw new LayoutIntegrityError(
      `${contract} compiled to no bytecode; cannot derive its layout.`,
    );
  }
  // OZ looks the contract up by bytecode version and takes the first match, so
  // two contracts with identical code (possible without a source hash) could
  // swap layouts. Listing the target first makes the lookup land on it.
  return getStorageLayout({ [contract]: runData[contract], ...runData }, version);
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
  solc: SolcRunner,
  input: SolcInput,
  what: string,
): Promise<SolcOutput> {
  const output = await solc.compile(input);
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new LayoutIntegrityError(
      `solc ${solc.longVersion} failed to compile the ${what}: ${errors[0].formattedMessage}`,
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
