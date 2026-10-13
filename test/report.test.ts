/**
 * The CLI report as text: the check list. The CLI tests cover the common
 * paths end to end.
 */
import { describe, it, expect } from "vitest";
import { checkLines } from "../src/report.js";

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
