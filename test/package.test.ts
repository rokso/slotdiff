/**
 * The published manifest, as npm reads it on publish.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

describe("package.json", () => {
  // npm 11 drops a bin path written as "./dist/bin.js" on publish ("script name
  // ... was invalid and removed"), which would ship a package without the CLI.
  it("names the CLI's file without a leading ./", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin).toEqual({ slotdiff: "dist/bin.js" });
  });
});
