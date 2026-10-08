/**
 * Bytecode comparison utilities.
 *
 * Solidity appends a CBOR-encoded metadata hash to the end of every compiled
 * contract's bytecode. The last two bytes encode the length of that metadata
 * section. Stripping it allows comparing contracts that are logically identical
 * but were compiled in different environments (different metadata).
 */

export function stripBytecodeMetadata(bytecode: string): string {
  const buf = toBuffer(bytecode);
  const start = cborStart(buf);
  if (start === undefined) return bytecode;
  return "0x" + buf.subarray(0, start).toString("hex");
}

function toBuffer(bytecode: string): Buffer {
  return Buffer.from(bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode, "hex");
}

// Where solc's CBOR metadata starts, or undefined when the tail is not CBOR.
function cborStart(buf: Buffer): number | undefined {
  if (buf.length < 2) return undefined;
  const metadataLength = buf.readUInt16BE(buf.length - 2);
  if (metadataLength === 0 || metadataLength + 2 > buf.length) return undefined;
  // solc's metadata is a CBOR map (major type 5). Without that marker the
  // tail is code (e.g. compiled with appendCBOR: false), and stripping it
  // would hide real differences.
  const start = buf.length - 2 - metadataLength;
  return buf[start] >> 5 === 5 ? start : undefined;
}

// The CBOR keys solc uses for the metadata hash, each with its byte-string header.
const SOURCE_HASH_KEYS = [
  Buffer.from("6469706673" + "5822", "hex"), // "ipfs", 34 bytes
  Buffer.from("65627a7a7230" + "5820", "hex"), // "bzzr0", 32 bytes
  Buffer.from("65627a7a7231" + "5820", "hex"), // "bzzr1", 32 bytes
];

/**
 * Whether compiled code embeds the hash of its metadata, which covers every
 * source file and the settings. Only then does matching code also mean
 * matching source. `bytecodeHash: "none"` and `appendCBOR: false` drop it.
 */
function hasSourceHash(bytecode: string): boolean {
  const buf = toBuffer(bytecode);
  const start = cborStart(buf);
  if (start === undefined) return false;
  const cbor = buf.subarray(start, buf.length - 2);
  return SOURCE_HASH_KEYS.some((key) => cbor.includes(key));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/^0x/, "");
}

// ---------------------------------------------------------------------------
// Compiled-vs-on-chain comparison
// ---------------------------------------------------------------------------

/**
 * solc's `evm.deployedBytecode.immutableReferences`: AST id to the byte spans
 * (relative to the deployed bytecode) that the constructor fills in.
 */
export type ImmutableReferences = Record<string, ReadonlyArray<{ start: number; length: number }>>;

/**
 * - `exact`: byte-identical.
 * - `immutables-only`: identical once immutable (and library-link) spans are
 *   masked. Same code, deployment-specific values. Every UUPS implementation
 *   lands here because `UUPSUpgradeable.__self` is immutable.
 * - `metadata-only`: identical after masking and stripping the CBOR metadata,
 *   so the compiler input was not byte-identical (source hashes or settings).
 *   NOT proof of storage layout: variables no code reads, gap sizes and field
 *   names do not reach the bytecode, so different layouts can share code.
 * - `code-only`: identical (exactly or once masked), but the build embeds no
 *   source hash (`bytecodeHash: "none"` or `appendCBOR: false`), so nothing
 *   ties the code to its source. NOT proof of layout, for the same reason.
 * - `none`: different code.
 *
 * `exact` and `immutables-only` therefore always mean the source is proven too.
 */
export type DeployedBytecodeMatch =
  "exact" | "immutables-only" | "metadata-only" | "code-only" | "none";

/** The matches that prove a source is the deployed code, and so prove its layout. */
export type ProvingMatch = "exact" | "immutables-only";

export function isProvingMatch(match: DeployedBytecodeMatch): match is ProvingMatch {
  return match === "exact" || match === "immutables-only";
}

// solc leaves `__$<34 hex>$__` (20 bytes) where an external library address is linked.
const LINK_PLACEHOLDER = /__\$[0-9a-fA-F]{34}\$__/g;

/**
 * Compares runtime code read with `eth_getCode` against compiler output.
 *
 * On-chain code has immutables filled in while compiler output has them
 * zeroed, and the difference sits in the code body where metadata stripping
 * cannot reach, so the spans are zeroed on both sides before comparing.
 */
export function compareDeployedBytecode(
  onchain: string,
  compiled: string,
  immutableReferences: ImmutableReferences = {},
): DeployedBytecodeMatch {
  const live = normalize(onchain);
  const built = normalize(compiled);
  if (live === "" || built === "") return "none";
  if (live === built) return hasSourceHash(built) ? "exact" : "code-only";

  const spans: Array<{ start: number; length: number }> = Object.values(immutableReferences).flat();
  for (const m of built.matchAll(LINK_PLACEHOLDER)) {
    spans.push({ start: m.index / 2, length: 20 });
  }
  const builtHex = built.replace(LINK_PLACEHOLDER, "0".repeat(40));

  const liveMasked = maskSpans(live, spans);
  const builtMasked = maskSpans(builtHex, spans);
  if (liveMasked === undefined || builtMasked === undefined) return "none";
  if (liveMasked === builtMasked) return hasSourceHash(builtHex) ? "immutables-only" : "code-only";
  if (stripBytecodeMetadata(liveMasked) === stripBytecodeMetadata(builtMasked)) {
    return "metadata-only";
  }
  return "none";
}

// Returns undefined when the hex is malformed or a span falls outside the code.
function maskSpans(
  hex: string,
  spans: ReadonlyArray<{ start: number; length: number }>,
): string | undefined {
  const buf = Buffer.from(hex, "hex");
  if (buf.length * 2 !== hex.length) return undefined;
  for (const { start, length } of spans) {
    if (start + length > buf.length) return undefined;
    buf.fill(0, start, start + length);
  }
  return buf.toString("hex");
}
