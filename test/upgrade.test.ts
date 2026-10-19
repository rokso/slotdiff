/**
 * `checkUpgrade` with a real solc: one verdict over the layout, the ERC-7201
 * slots and the safety rules, with the proxy kind taken from `old`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SolcInput } from "@openzeppelin/upgrades-core";
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
// From the public entry point: library callers get the CLI's verdict.
import { analyzeSource, checkUpgrade, type ProxyKind, type SourceAnalysis } from "../src/index.js";
import { getSolc, type SolcRunner } from "../src/solc.js";

const header = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n";
const LOCATION = calculateERC7201StorageLocation("x.main");
const UPGRADE = "function upgradeToAndCall(address, bytes memory) external payable {}";

let solc: SolcRunner;

beforeAll(async () => {
  solc = await getSolc("0.8.24+commit.e11b9ed9");
}, 120_000);

// `vars` are regular state variables; `body` goes in the contract as is.
async function analyze(vars: string, body = ""): Promise<SourceAnalysis> {
  const content = `${header}contract C {
    /// @custom:storage-location erc7201:x.main
    struct S { uint256 a; }
    ${vars}
    function _s() private pure returns (S storage $) { assembly { $.slot := ${LOCATION} } }
    function a() external view returns (uint256) { return _s().a; }
    ${body}
}`;
  const input = {
    language: "Solidity",
    sources: { "src/C.sol": { content } },
    settings: {},
  } as SolcInput;
  return analyzeSource(input, solc, "src/C.sol:C");
}

describe("checkUpgrade", () => {
  it("passes an append-only upgrade, every check run", async () => {
    const check = checkUpgrade(await analyze("uint256 x;"), await analyze("uint256 x; uint256 y;"));
    expect(check.result).toBe("pass");
    expect(check.layout.ok).toBe(true);
    expect(check.namespaces.result).toBe("pass");
    expect(check.safety?.ok).toBe(true);
  }, 60_000);

  it("takes the proxy kind from old: a UUPS implementation that lost its upgrade function fails", async () => {
    const old = await analyze("uint256 x;", UPGRADE);
    const next = await analyze("uint256 x;");
    expect([old.kind, next.kind]).toEqual(["uups", "transparent"]);
    const check = checkUpgrade(old, next);
    expect(check.result).toBe("fail");
    expect(check.safety?.errors.map((e) => e.kind)).toEqual(["missing-public-upgradeto"]);
  }, 60_000);

  it("leaves a record without namespace slots unchecked, never passed", async () => {
    const { layout, kind } = await analyze("uint256 x;");
    const check = checkUpgrade({ layout, kind }, await analyze("uint256 x;"));
    expect(check.layout.ok).toBe(true);
    expect(check.result).toBe("unchecked");
  }, 60_000);

  it("fails before it gives up: a failing check outranks an unread slot", async () => {
    const { layout, kind } = await analyze("uint256 x;");
    const check = checkUpgrade({ layout, kind }, await analyze("uint256 y; uint256 x;"));
    expect(check.layout.ok).toBe(false);
    expect(check.result).toBe("fail");
  }, 60_000);

  it("skips only the safety rules when asked", async () => {
    const unsafe = "constructor() { }";
    const check = checkUpgrade(await analyze("uint256 x;"), await analyze("uint256 x;", unsafe), {
      skipSafety: true,
    });
    expect(check.safety).toBeUndefined();
    expect(check.result).toBe("pass");
  }, 60_000);

  it("passes the accepted error kinds and renames on to OpenZeppelin", async () => {
    const old = await analyze("uint256 x;");
    const next = await analyze("uint256 renamed;", "constructor() { }");
    expect(checkUpgrade(old, next).result).toBe("fail");
    const check = checkUpgrade(old, next, {
      unsafeAllow: ["constructor"],
      unsafeAllowRenames: true,
    });
    expect([check.layout.ok, check.safety?.ok, check.result]).toEqual([true, true, "pass"]);
  }, 60_000);

  it("compares two records without the safety rules, the slots of both still checked", async () => {
    // As a deploy hook compares saved records: no analysis of next, no proxy kind needed.
    const { layout, namespaces } = await analyze("uint256 x;");
    const moved = await analyze("uint256 x;");
    const elsewhere = moved.namespaces.map((n) => ({
      ...n,
      actual: "0x" + "11".repeat(32),
      status: "mismatch" as const,
    }));
    const pass = checkUpgrade({ layout, namespaces }, { layout, namespaces }, { skipSafety: true });
    expect(pass.result).toBe("pass");
    const fail = checkUpgrade(
      { layout, namespaces },
      { layout: moved.layout, namespaces: elsewhere },
      { skipSafety: true },
    );
    expect(fail.namespaces.pairs[0].problem).toBe("moved");
    expect(fail.result).toBe("fail");
    const unread = checkUpgrade({ layout, namespaces }, { layout }, { skipSafety: true });
    expect(unread.result).toBe("unchecked");
  }, 60_000);

  it.each([undefined, "UUPS", "proxy"])(
    "refuses a proxy kind of %s, which OpenZeppelin would treat as uups",
    async (kind) => {
      const old = { ...(await analyze("uint256 x;")), kind } as unknown as SourceAnalysis;
      expect(() => checkUpgrade(old, old)).toThrow(/kind of the proxy being upgraded/);
    },
    60_000,
  );

  it("refuses to run the safety rules without an analysis of next", async () => {
    const old = await analyze("uint256 x;");
    const record = { layout: old.layout, namespaces: old.namespaces } as unknown as SourceAnalysis;
    expect(() => checkUpgrade(old, record)).toThrow(/analysis of next/);
  }, 60_000);

  it("fails closed for an older record without a kind, with the documented uups fallback", async () => {
    // A record of a UUPS implementation from before records kept their kind.
    const { layout, namespaces } = await analyze("uint256 x;", UPGRADE);
    const record: { layout: typeof layout; namespaces: typeof namespaces; kind?: ProxyKind } = {
      layout,
      namespaces,
    };
    const lost = await analyze("uint256 x;");
    expect(checkUpgrade({ ...record, kind: record.kind ?? "uups" }, lost).result).toBe("fail");
    expect(checkUpgrade({ ...record, kind: "transparent" }, lost).result).toBe("pass"); // why not
    const kept = await analyze("uint256 x;", UPGRADE);
    expect(checkUpgrade({ ...record, kind: record.kind ?? "uups" }, kept).result).toBe("pass");
  }, 60_000);
});
