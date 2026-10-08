/**
 * Proven layouts of deployed code, as `LayoutRecord`s. Nothing here writes to
 * disk; see `record.ts` for saving and loading records.
 *
 * Under lazy or queued (multisig) upgrades, a project's files describe its
 * latest build while proxies keep running older implementations. Reading the
 * implementation from the chain and proving its source against the deployed
 * code gives the layout of what actually runs.
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import {
  compareDeployedBytecode,
  isProvingMatch,
  type DeployedBytecodeMatch,
  type ImmutableReferences,
} from "./bytecode.js";
import { codeSha256, readChainId, readCode, readProxy, type EthProvider } from "./chain.js";
import { LayoutUnavailableError } from "./errors.js";
import { canQueryExplorer, fetchVerifiedSource, type ExplorerConfig } from "./explorer.js";
import { reconstructLayout } from "./reconstruct.js";
import { parseRecord, type LayoutRecord } from "./record.js";
import { getSolc, type SolcOptions } from "./solc.js";

export interface ResolveOptions {
  explorer: ExplorerConfig;
  solc?: SolcOptions;
}

/**
 * Rebuilds the layout of the code at `address` from its verified source and
 * proves that source is the deployed code. Always fetches and compiles; check
 * your own saved record first (`verifyRecord`) to skip that.
 */
export async function resolveLayout(
  provider: EthProvider,
  address: string,
  options: ResolveOptions,
): Promise<LayoutRecord> {
  const lower = address.toLowerCase();
  if (!canQueryExplorer(options.explorer)) {
    throw new LayoutUnavailableError(
      `Cannot rebuild the layout of ${lower}: the explorer needs an apiKey or an apiUrl.`,
    );
  }
  const code = await readCode(provider, lower);
  const chainId = await readChainId(provider);
  const source = await fetchVerifiedSource(chainId, lower, options.explorer);
  const solc = await getSolc(source.solcLongVersion, options.solc);
  const rebuilt = await reconstructLayout(source, solc, code);

  return {
    format: 1,
    address: lower,
    chainId,
    codeSha256: codeSha256(code),
    contract: rebuilt.contract,
    compiler: rebuilt.compiler,
    bytecodeMatch: rebuilt.bytecodeMatch,
    source: "explorer",
    recordedAt: new Date().toISOString(),
    layout: rebuilt.layout,
  };
}

export interface ProxyLayout {
  /** The implementation the proxy runs now. */
  implementation: string;
  /** Set for a beacon proxy. */
  beacon?: string;
  record: LayoutRecord;
}

/** `resolveLayout` for whatever implementation `proxy` runs right now (ERC-1967 or beacon). */
export async function resolveProxyLayout(
  provider: EthProvider,
  proxy: string,
  options: ResolveOptions,
): Promise<ProxyLayout> {
  const state = await readProxy(provider, proxy);
  if (state === undefined) {
    throw new LayoutUnavailableError(
      `${proxy} has no ERC-1967 implementation or beacon slot set on this chain.`,
    );
  }
  const record = await resolveLayout(provider, state.implementation, options);
  return { ...state, record };
}

export interface LocalBuild {
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  compiler?: string;
  layout: StorageLayout;
  deployedBytecode: string;
  immutableReferences?: ImmutableReferences;
}

export interface LocalBuildResult {
  bytecodeMatch: DeployedBytecodeMatch;
  /** Set only when the match proves the layout (`exact` or `immutables-only`). */
  record?: LayoutRecord;
}

/**
 * Makes a record from a local build of the code at `address`, but only after
 * proving the chain runs that build. A `metadata-only` or `none` match gives
 * no record, so a layout is never attributed to code that is not there.
 */
export async function proveLocalBuild(
  provider: EthProvider,
  address: string,
  build: LocalBuild,
): Promise<LocalBuildResult> {
  const lower = address.toLowerCase();
  const code = await readCode(provider, lower);
  const bytecodeMatch = compareDeployedBytecode(
    code,
    build.deployedBytecode,
    build.immutableReferences,
  );
  if (!isProvingMatch(bytecodeMatch)) return { bytecodeMatch };

  const record: LayoutRecord = {
    format: 1,
    address: lower,
    chainId: await readChainId(provider),
    codeSha256: codeSha256(code),
    contract: build.contract,
    ...(build.compiler !== undefined ? { compiler: build.compiler } : {}),
    bytecodeMatch,
    source: "local-compile",
    recordedAt: new Date().toISOString(),
    layout: build.layout,
  };
  // A record this returns must load back through parseRecord, so check it now.
  return { bytecodeMatch, record: parseRecord(JSON.parse(JSON.stringify(record)), lower) };
}
