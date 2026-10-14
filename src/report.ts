/**
 * The CLI's report: the ERC-7201 namespace grid and the check list. Pure
 * functions from results to lines, so the layout is tested as text. Colors
 * come from `paint`, applied after alignment so they never shift a column.
 */

import type { NamespacePair, NamespaceSlot } from "./erc7201.js";

/** Node's `util.styleText`, or `plain` when colors are off. */
export type Paint = (
  format: Parameters<typeof import("node:util").styleText>[0],
  text: string,
) => string;

export const plain: Paint = (_, text) => text;

export type CheckStatus = "pass" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  summary: string;
  /** Multi-line explanation shown under the check, such as OpenZeppelin's report. */
  details?: string;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "-" };
const TONE = { pass: "green", fail: "red", skip: "yellow" } as const;

/** One line per check, names aligned, details indented under their check. */
export function checkLines(checks: Check[], paint: Paint = plain): string[] {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.flatMap((c) => [
    `${paint(TONE[c.status], MARK[c.status])} ${paint("bold", c.name.padEnd(width))}   ${c.summary}`,
    ...(c.details?.split("\n").map((line) => `    ${line}`) ?? []),
  ]);
}

/**
 * A grid for each namespace whose slot is in question on either side: the
 * annotation, the slot it implies and the slot the code uses, for old and new,
 * with a sentence saying what that means. Namespaces that line up are left out.
 */
export function namespaceLines(pairs: NamespacePair[], paint: Paint = plain): string[] {
  const blocks = pairs
    // A side that is absent is not a problem here; OpenZeppelin reports a deleted namespace.
    .filter(
      (p) =>
        p.problem !== undefined ||
        [p.old, p.next].some((s) => s !== undefined && s.status !== "match"),
    )
    .map((p) => {
      const fmt = formatter([p.old, p.next]);
      return {
        rows: [
          ...(p.old !== undefined ? [row("old", p.old, fmt)] : []),
          ...(p.next !== undefined ? [row("new", p.next, fmt)] : []),
        ],
        meaning: meaning(p, fmt),
        tone: (p.problem === undefined
          ? "dim"
          : p.problem === "unread"
            ? "yellow"
            : "red") as Row["tone"],
      };
    });
  if (blocks.length === 0) return [];

  const header = {
    side: "",
    id: "annotation",
    implied: "slot from annotation",
    inCode: "slot in code",
    mark: "",
    tone: "dim",
  } as Row;
  const all = [header, ...blocks.flatMap((b) => b.rows)];
  const width = (key: "id" | "implied" | "inCode") => Math.max(...all.map((r) => r[key].length));
  const cells = (r: Row) =>
    `  ${r.side.padEnd(5)}${r.id.padEnd(width("id"))}   ${r.implied.padEnd(width("implied"))}   ` +
    r.inCode.padEnd(width("inCode"));
  const line = (r: Row) => `${cells(r)}   ${paint(r.tone, r.mark)}`;

  return [
    paint("bold", "ERC-7201 namespaces"),
    paint("dim", cells(header).trimEnd()),
    ...blocks.flatMap((b) => [...b.rows.map(line), `       ${paint(b.tone, b.meaning)}`]),
  ];
}

interface Row {
  side: string;
  id: string;
  implied: string;
  inCode: string;
  mark: string;
  tone: "green" | "red" | "yellow" | "dim";
}

function row(side: string, s: NamespaceSlot, fmt: (slot: string) => string): Row {
  return {
    side,
    id: s.namespace.slice("erc7201:".length),
    implied: fmt(s.expected),
    inCode:
      s.status === "conflict" ? "several" : s.actual !== undefined ? fmt(s.actual) : "not read",
    mark: {
      match: "✓",
      mismatch: "✗ annotation does not match code",
      conflict: "✗ code uses more than one slot",
      unread: "? slot in code not read",
    }[s.status],
    tone: ({ match: "green", mismatch: "red", conflict: "red", unread: "yellow" } as const)[
      s.status
    ],
  };
}

function meaning({ old, next, problem }: NamespacePair, fmt: (slot: string) => string): string {
  switch (problem) {
    case "conflict":
      return "The new code assigns more than one slot to this namespace; it must use one.";
    case "moved":
      return (
        `The new code moves this namespace from ${fmt(old!.actual!)} to ${fmt(next!.actual!)}: ` +
        "its data would be left behind. Keep the slot the deployed code uses, under an annotation that matches it."
      );
    case "mismatch":
      return old === undefined
        ? "The new code keeps this namespace in a different slot than its annotation says. Fix one of the two before deploying."
        : "The storage did not move, but the new annotation does not match its code. Fix it before deploying.";
    case "unread":
      return "The slot in code could not be read (computed at run time?), so this namespace could not be checked.";
  }
  return next !== undefined
    ? "Same slot in code on both sides: the storage did not move. Compared as one namespace."
    : "The deployed annotation does not match its code, and no namespace in the new code uses its slot.";
}

/**
 * Short slots for a block, unless two different slots in it would then look
 * the same: a hand-written constant can share both ends with another.
 */
function formatter(sides: Array<NamespaceSlot | undefined>): (slot: string) => string {
  const slots = new Set(
    sides.flatMap((s) => (s === undefined ? [] : [s.expected, s.actual ?? s.expected])),
  );
  const shorts = new Set([...slots].map(short));
  return shorts.size === slots.size ? short : (slot) => slot;
}

/** `0x5ea2…5c00`: enough to tell slots apart; slotdiff does the comparing. */
function short(slot: string): string {
  return `${slot.slice(0, 6)}…${slot.slice(-4)}`;
}
