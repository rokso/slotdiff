/**
 * diffLayouts is OZ's storage comparison. These tests pin the cases slotdiff
 * promises (appends pass; deletes, inserts, renames and type changes fail,
 * also inside ERC-7201 namespaces; tagged renames and retypes pass) so an
 * upgrades-core bump that changes any of them fails here.
 *
 * Uses synthetic StorageLayout objects (no compiled fixtures required).
 */
import { describe, it, expect } from "vitest";
import { diffLayouts } from "../src/diff.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { layout, u256, u128, u160, addr } from "./helpers/layout-builder.js";

const T_U256 = { label: "uint256", numberOfBytes: "32" };
const T_U128 = { label: "uint128", numberOfBytes: "16" };

function withRenamedFrom(l: StorageLayout, label: string, from: string): StorageLayout {
  l.storage.find((s) => s.label === label)!.renamedFrom = from;
  return l;
}

function withRetypedFrom(l: StorageLayout, label: string, from: string): StorageLayout {
  l.storage.find((s) => s.label === label)!.retypedFrom = from;
  return l;
}

function nsLayout(
  nsId: string,
  items: Array<{ label: string; typeId: "t_uint256" | "t_uint128"; renamedFrom?: string }>,
): StorageLayout {
  return {
    storage: [],
    types: { t_uint256: T_U256, t_uint128: T_U128 },
    namespaces: {
      [nsId]: items.map(({ label, typeId, renamedFrom }, i) => ({
        contract: `namespace:${nsId}`,
        label,
        offset: 0,
        slot: String(i),
        type: typeId,
        src: "",
        ...(renamedFrom !== undefined ? { renamedFrom } : {}),
      })),
    },
  };
}

const opKinds = (r: ReturnType<typeof diffLayouts>) => r.ops.map((op) => op.kind);

describe("diffLayouts", () => {
  it("passes an append", () => {
    const r = diffLayouts(layout(u256("a")), layout(u256("a"), u256("b")));
    expect(r.ok).toBe(true);
    expect(r.explain()).toBe("");
  });

  it("fails a removal", () => {
    const r = diffLayouts(layout(u256("a"), u256("b")), layout(u256("a")));
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["delete"]);
  });

  it("fails an insertion in the middle", () => {
    const r = diffLayouts(layout(u256("a"), u256("b")), layout(u256("a"), u256("x"), u256("b")));
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toContain("insert");
  });

  it("fails a type change", () => {
    const r = diffLayouts(layout(u256("a")), layout(u128("a")));
    expect(r.ok).toBe(false);
  });

  it("fails a rename without oz-renamed-from", () => {
    const r = diffLayouts(layout(u256("a")), layout(u256("b")));
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["rename"]);
  });

  it("passes a rename approved with renamedFrom", () => {
    const r = diffLayouts(layout(u256("a")), withRenamedFrom(layout(u256("b")), "b", "a"));
    expect(r.ok).toBe(true);
  });

  it("fails a rename whose renamedFrom names another variable", () => {
    const r = diffLayouts(layout(u256("a")), withRenamedFrom(layout(u256("b")), "b", "other"));
    expect(r.ok).toBe(false);
  });

  it("passes any rename with unsafeAllowRenames (OZ's option)", () => {
    const r = diffLayouts(layout(u256("a")), layout(u256("b")), {
      unsafeAllowRenames: true,
    });
    expect(r.ok).toBe(true);
  });

  it("passes uint160 -> address with retypedFrom (same size, slot known)", () => {
    const r = diffLayouts(
      layout(u160("owner")),
      withRetypedFrom(layout(addr("owner")), "owner", "uint160"),
    );
    expect(r.ok).toBe(true);
  });

  it("fails a size change even with retypedFrom", () => {
    const r = diffLayouts(
      layout(u256("a"), u256("b")),
      withRetypedFrom(layout(u128("a"), u256("b")), "a", "uint256"),
    );
    expect(r.ok).toBe(false);
  });

  it("fails a removed namespace", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const r = diffLayouts(old, { storage: [], types: {}, namespaces: {} });
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["delete-namespace"]);
  });

  it("fails a namespace member rename without renamedFrom, passes with it", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const untagged = nsLayout("erc7201:a", [{ label: "y", typeId: "t_uint256" }]);
    const tagged = nsLayout("erc7201:a", [{ label: "y", typeId: "t_uint256", renamedFrom: "x" }]);
    expect(diffLayouts(old, untagged).ok).toBe(false);
    expect(diffLayouts(old, tagged).ok).toBe(true);
  });

  it("fails a namespace member type change", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const changed = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint128" }]);
    expect(diffLayouts(old, changed).ok).toBe(false);
  });

  it("explains a failure in OZ's words", () => {
    const r = diffLayouts(layout(u256("a"), u256("b")), layout(u256("a")));
    expect(r.explain(false)).toContain("Deleted `b`");
  });
});
