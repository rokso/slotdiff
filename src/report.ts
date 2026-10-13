/**
 * The CLI's plain-text report: the check list.
 * Pure functions from results to lines, so the layout is tested as text.
 */

export type CheckStatus = "pass" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  summary: string;
  /** Multi-line explanation shown under the check, such as OpenZeppelin's report. */
  details?: string;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "-" };

/** One line per check, names aligned, details indented under their check. */
export function checkLines(checks: Check[]): string[] {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.flatMap((c) => [
    `${MARK[c.status]} ${c.name.padEnd(width)}   ${c.summary}`,
    ...(c.details?.split("\n").map((line) => `    ${line}`) ?? []),
  ]);
}
