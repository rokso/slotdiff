/**
 * The CLI report as text: the ERC-7201 grid for each kind of slot result, and
 * the check list. The CLI tests cover the common paths end to end.
 */
import { describe, it, expect } from "vitest";
import { checkLines, namespaceLines } from "../src/report.js";
import { checkNamespaces, type NamespaceSlot } from "../src/erc7201.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";

const A = "0xaaaa000000000000000000000000000000000000000000000000000000001100";
const B = "0xbbbb000000000000000000000000000000000000000000000000000000002200";

// The grid for old and new slots, paired as the CLI pairs them.
function grid(old: NamespaceSlot[], next: NamespaceSlot[]): string[] {
  const side = (namespaces: NamespaceSlot[]) => ({
    layout: {
      storage: [],
      types: {},
      namespaces: Object.fromEntries(namespaces.map((n) => [n.namespace, []])),
    } as unknown as StorageLayout,
    namespaces,
  });
  return namespaceLines(checkNamespaces(side(old), side(next)).pairs);
}

function ns(id: string, expected: string, rest: Partial<NamespaceSlot>): NamespaceSlot {
  return { namespace: `erc7201:${id}`, expected, status: "match", actual: expected, ...rest };
}

describe("namespaceLines", () => {
  it("shows nothing when every slot matches", () => {
    expect(grid([ns("x", A, {})], [ns("x", A, {})])).toEqual([]);
  });

  it("shows nothing for a matching namespace that only one side has", () => {
    // A namespace gone from the new version is OpenZeppelin's to report, as deleted.
    expect(grid([ns("x", A, {})], [])).toEqual([]);
    expect(grid([], [ns("x", A, {})])).toEqual([]);
  });

  it("marks a slot that could not be read, and says only annotations were compared", () => {
    const unread = ns("x", A, { status: "unread", actual: undefined });
    expect(grid([unread], [unread])).toEqual([
      "ERC-7201 namespaces",
      "       annotation   slot from annotation   slot in code",
      "  old  x            0xaaaa…1100            not read       ? slot in code not read",
      "  new  x            0xaaaa…1100            not read       ? slot in code not read",
      "       The slot in code could not be read (computed at run time?), so this namespace could not be checked.",
    ]);
  });

  it("marks a namespace given more than one slot", () => {
    const lines = grid([], [ns("x", A, { status: "conflict", actual: undefined })]);
    expect(lines[2]).toBe(
      "  new  x            0xaaaa…1100            several        ✗ code uses more than one slot",
    );
    expect(lines[3]).toContain("assigns more than one slot");
  });

  it("explains a new mismatch with no old namespace to compare", () => {
    const lines = grid([], [ns("x", A, { status: "mismatch", actual: B })]);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain("in a different slot than its annotation says");
  });

  it("explains a new annotation that is wrong where the storage did not move", () => {
    const lines = grid(
      [ns("x", A, { status: "mismatch", actual: B })],
      [ns("x", A, { status: "mismatch", actual: B })],
    );
    expect(lines.at(-1)).toContain("The storage did not move, but the new annotation");
  });

  it("explains an old mismatch that no new namespace shares", () => {
    const lines = grid([ns("x", A, { status: "mismatch", actual: B })], []);
    expect(lines.at(-1)).toContain("The deployed annotation does not match its code");
  });
});

describe("namespaceLines pairing", () => {
  // The old annotation was wrong (its code used B); the new annotation names B,
  // but the new code moved the data to B + 1. One namespace, shown as one block.
  const C = "0xbbbb000000000000000000000000000000000000000000000000000000002201";

  it("pairs a new annotation with the old namespace whose data it points at", () => {
    expect(
      grid(
        [ns("old.id", A, { status: "mismatch", actual: B })],
        [ns("new.id", B, { status: "mismatch", actual: C })],
      ),
    ).toEqual([
      "ERC-7201 namespaces",
      "       annotation   slot from annotation   slot in code",
      "  old  old.id       0xaaaa…1100            0xbbbb…2200    ✗ annotation does not match code",
      "  new  new.id       0xbbbb…2200            0xbbbb…2201    ✗ annotation does not match code",
      "       The new code moves this namespace from 0xbbbb…2200 to 0xbbbb…2201: its data would be left behind. Keep the slot the deployed code uses, under an annotation that matches it.",
    ]);
  });

  it("shows slots in full when two different ones would shorten alike", () => {
    const lookalike = "0xbbbb111111111111111111111111111111111111111111111111111111112200";
    const lines = grid([], [ns("x", B, { status: "mismatch", actual: lookalike })]);
    expect(lines[2]).toContain(B);
    expect(lines[2]).toContain(lookalike);
  });
});

describe("checkLines", () => {
  it("aligns check names and indents details under their check", () => {
    expect(
      checkLines([
        { name: "Storage layout", status: "fail", summary: "incompatible", details: "a\n  b" },
        { name: "Safety rules", status: "skip", summary: "skipped" },
        { name: "Short", status: "pass", summary: "fine" },
      ]),
    ).toEqual([
      "✗ Storage layout   incompatible",
      "    a",
      "      b",
      "- Safety rules     skipped",
      "✓ Short            fine",
    ]);
  });
});
