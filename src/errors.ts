/**
 * The chain cannot supply a layout: no implementation behind the proxy slots,
 * no code at the address, unverified source, an unsupported verification
 * format, or no explorer configured. Callers may fall back to another source.
 */
export class LayoutUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutUnavailableError";
  }
}

/**
 * The answer cannot be trusted: rebuilt bytecode does not match the deployed
 * code, a record describes different code or another chain, or compilation
 * failed. Never fall back on this one, since a silent fallback would compare
 * against a layout nothing is running.
 */
export class LayoutIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutIntegrityError";
  }
}

/**
 * A network error's code (ECONNREFUSED, ENOTFOUND), never its message: fetch
 * quotes the URL in some messages, and URLs carry API keys.
 */
export function errorCode(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" ? code : "network error";
}
