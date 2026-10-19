/**
 * Layout records: the proven storage layout of the code at one address on one
 * chain. slotdiff never writes them anywhere. A record is plain JSON, so the
 * caller saves it however it likes and loads it back through `parseRecord`
 * (offline) or `verifyRecord` (against the chain):
 *
 *   await writeFile(path, JSON.stringify(record, null, 2));
 *   const record = await verifyRecord(provider, address, JSON.parse(await readFile(path, "utf8")));
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { isProvingMatch, type ProvingMatch } from "./bytecode.js";
import { codeSha256, readChainId, readCode, type EthProvider } from "./chain.js";
import { slotsMisfit, type NamespaceSlot } from "./erc7201.js";
import type { SourceAnalysis } from "./reconstruct.js";
import { LayoutIntegrityError, LayoutUnavailableError } from "./errors.js";

/**
 * Deployed code never changes, so a record cannot go stale for its chain and
 * address. `codeSha256` binds it to the exact runtime code it was proven
 * against; `verifyRecord` refuses it for any other code or chain.
 */
export interface LayoutRecord {
  format: 1;
  /** Lowercase. */
  address: string;
  chainId: number;
  codeSha256: string;
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  /** solc long version, when known. */
  compiler?: string;
  bytecodeMatch: ProvingMatch;
  /** `explorer`: rebuilt from verified source. `local-compile`: proven against a local build. */
  source: "explorer" | "local-compile";
  recordedAt: string;
  layout: StorageLayout;
  /**
   * The proxy kind this code implies: `uups` when it has `upgradeTo` or
   * `upgradeToAndCall`, else `transparent`. Pass `beacon` to the safety check
   * instead when a beacon serves it. Absent in older records.
   */
  kind?: SourceAnalysis["kind"];
  /**
   * The slot each ERC-7201 namespace in `layout` really uses. Without it,
   * `checkNamespaces` reports the record's namespaces as unread.
   */
  namespaces?: NamespaceSlot[];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks a loaded record without touching the chain: its format, its shape,
 * and that it rests on a match that proves a layout. Pass `address` to also
 * require that it describes that address. Use `verifyRecord` whenever an RPC
 * is available; this alone cannot tell that the code at the address changed
 * or that the record came from another chain.
 */
export function parseRecord(value: unknown, address?: string): LayoutRecord {
  if (typeof value !== "object" || value === null) {
    throw new LayoutIntegrityError("A layout record must be a JSON object.");
  }
  const r = value as Partial<LayoutRecord>;
  if (r.format !== 1) {
    throw new Error(`Unsupported layout record format ${String(r.format)}; upgrade slotdiff.`);
  }
  const who = typeof r.address === "string" ? r.address : "an unknown address";
  const malformed = (field: string) =>
    new LayoutIntegrityError(`The layout record for ${who} has a missing or malformed ${field}.`);

  if (typeof r.address !== "string" || !ADDRESS.test(r.address)) throw malformed("address");
  if (!Number.isSafeInteger(r.chainId) || (r.chainId as number) <= 0) throw malformed("chainId");
  if (typeof r.codeSha256 !== "string" || !SHA256.test(r.codeSha256)) {
    throw malformed("codeSha256");
  }
  if (typeof r.contract !== "string" || !r.contract.includes(":")) throw malformed("contract");
  if (r.compiler !== undefined && typeof r.compiler !== "string") throw malformed("compiler");
  if (r.source !== "explorer" && r.source !== "local-compile") throw malformed("source");
  if (typeof r.recordedAt !== "string") throw malformed("recordedAt");
  if (
    typeof r.layout !== "object" ||
    r.layout === null ||
    !Array.isArray(r.layout.storage) ||
    typeof r.layout.types !== "object" ||
    r.layout.types === null
  ) {
    throw malformed("layout");
  }
  if (r.kind !== undefined && r.kind !== "uups" && r.kind !== "transparent") {
    throw malformed("kind");
  }
  if (slotsMisfit(r.layout, undefined) !== undefined) throw malformed("layout");
  if (slotsMisfit(r.layout, r.namespaces) !== undefined) throw malformed("namespaces");
  if (typeof r.bytecodeMatch !== "string" || !isProvingMatch(r.bytecodeMatch)) {
    throw new LayoutIntegrityError(
      `The layout record for ${who} rests on a "${String(r.bytecodeMatch)}" match, which does ` +
        `not prove a storage layout.`,
    );
  }
  if (address !== undefined && r.address !== address.toLowerCase()) {
    throw new LayoutIntegrityError(
      `The layout record for ${r.address} was loaded for ${address.toLowerCase()}.`,
    );
  }
  return r as LayoutRecord;
}

/**
 * `parseRecord`, then checks the record against the chain: it must have been
 * made on this chain, and the code at `address` must be the code it was
 * proven against. Returns the record, ready to diff.
 */
export async function verifyRecord(
  provider: EthProvider,
  address: string,
  value: unknown,
): Promise<LayoutRecord> {
  const record = parseRecord(value, address);
  const chainId = await readChainId(provider);
  if (record.chainId !== chainId) {
    throw new LayoutIntegrityError(
      `The layout record for ${record.address} was made on chain ${record.chainId}, not on ` +
        `chain ${chainId}.`,
    );
  }
  let code: string;
  try {
    code = await readCode(provider, record.address);
  } catch (e) {
    // The code the record was proven against is gone; never a reason to fall back.
    if (!(e instanceof LayoutUnavailableError)) throw e;
    throw new LayoutIntegrityError(
      `The layout record for ${record.address} describes code that is no longer at that address.`,
    );
  }
  if (codeSha256(code) !== record.codeSha256) {
    throw new LayoutIntegrityError(
      `The layout record for ${record.address} was proven against different code than this ` +
        `chain has at that address.`,
    );
  }
  return record;
}
