/**
 * Builder helpers for constructing OZ-format StorageLayout fixtures in tests.
 *
 * Usage:
 *   const old = layout(u256("value"), u256("owner"), gap(50));
 *   const new_ = layout(u256("value"), u256("owner"), u256("extra"), gap(49));
 */

import type { StorageLayout, StorageItem, TypeItem } from "@openzeppelin/upgrades-core";

type PrimitiveKind = "uint256" | "uint128" | "uint160" | "address" | "bool";

type PrimitiveSpec = { kind: PrimitiveKind; label: string };
type GapSpec = { kind: "gap"; label: string; size: number };
type DynGapSpec = { kind: "dynGap"; label: string };

export type EntrySpec = PrimitiveSpec | GapSpec | DynGapSpec;

export const u256 = (label: string): EntrySpec => ({ kind: "uint256", label });
export const u128 = (label: string): EntrySpec => ({ kind: "uint128", label });
export const u160 = (label: string): EntrySpec => ({ kind: "uint160", label });
export const addr = (label: string): EntrySpec => ({ kind: "address", label });
export const bool = (label: string): EntrySpec => ({ kind: "bool", label });

export const gap = (size: number, label = "__gap"): EntrySpec => ({
  kind: "gap",
  label,
  size,
});

export const dynGap = (label = "__gap"): EntrySpec => ({
  kind: "dynGap",
  label,
});

const PRIMITIVE_TYPE_DEFS: Record<
  PrimitiveKind,
  { typeId: string; label: string; numberOfBytes: string }
> = {
  uint256: { typeId: "t_uint256", label: "uint256", numberOfBytes: "32" },
  uint128: { typeId: "t_uint128", label: "uint128", numberOfBytes: "16" },
  uint160: { typeId: "t_uint160", label: "uint160", numberOfBytes: "20" },
  address: { typeId: "t_address", label: "address", numberOfBytes: "20" },
  bool: { typeId: "t_bool", label: "bool", numberOfBytes: "1" },
};

/**
 * Builds an OZ-format StorageLayout from a list of variable specs.
 * Slots are assigned sequentially starting at 0.
 */
export function layout(...specs: EntrySpec[]): StorageLayout {
  const storage: StorageItem[] = [];
  const types: Record<string, TypeItem> = {};

  let slot = 0;

  for (const spec of specs) {
    if (spec.kind === "gap") {
      const typeId = `t_array(t_uint256)${spec.size}_storage`;
      storage.push({
        contract: "A",
        label: spec.label,
        offset: 0,
        slot: String(slot++),
        type: typeId,
        src: "",
      });
      types["t_uint256"] ??= { label: "uint256", numberOfBytes: "32" };
      types[typeId] = {
        label: `uint256[${spec.size}]`,
        numberOfBytes: String(spec.size * 32),
      };
    } else if (spec.kind === "dynGap") {
      const typeId = "t_array(t_uint256)dyn_storage";
      storage.push({
        contract: "A",
        label: spec.label,
        offset: 0,
        slot: String(slot++),
        type: typeId,
        src: "",
      });
      types["t_uint256"] ??= { label: "uint256", numberOfBytes: "32" };
      types[typeId] = { label: "uint256[]", numberOfBytes: "32" };
    } else {
      const def = PRIMITIVE_TYPE_DEFS[spec.kind];
      storage.push({
        contract: "A",
        label: spec.label,
        offset: 0,
        slot: String(slot++),
        type: def.typeId,
        src: "",
      });
      types[def.typeId] = {
        label: def.label,
        numberOfBytes: def.numberOfBytes,
      };
    }
  }

  return { storage, types };
}
