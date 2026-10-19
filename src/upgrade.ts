/**
 * The whole upgrade check in one call, as the CLI runs it: the storage layout,
 * the ERC-7201 slots and OpenZeppelin's safety rules, with one verdict.
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { diffLayouts, type DiffOptions, type LayoutReport } from "./diff.js";
import { checkNamespaces, type NamespaceCheck, type NamespaceSlot } from "./erc7201.js";
import type { ProxyKind, SafetyErrorKind, SafetyReport, SourceAnalysis } from "./reconstruct.js";

export interface UpgradeOptions extends DiffOptions {
  /** Error kinds to accept anyway (OZ's `unsafeAllow`). Prefer NatSpec exceptions in the source. */
  unsafeAllow?: SafetyErrorKind[];
  /** Skip the safety rules; the layout and slots are still checked. */
  skipSafety?: boolean;
}

/** A layout with the slot of each namespace, such as a `LayoutRecord` or a `SourceAnalysis`. */
export interface UpgradeSide {
  layout: StorageLayout;
  /** Without them, the namespaces are unchecked. */
  namespaces?: NamespaceSlot[];
}

export interface UpgradeCheck {
  /** OpenZeppelin's comparison, with each namespace paired by the slot in code. */
  layout: LayoutReport;
  namespaces: NamespaceCheck;
  /** Absent with `skipSafety`: then `pass` covers the layout and slots only. */
  safety?: SafetyReport;
  /**
   * `fail`: a check failed. `unchecked`: none failed, but an ERC-7201 slot
   * could not be read (`unread` in `namespaces`). `pass`: every check that ran passed.
   */
  result: "pass" | "fail" | "unchecked";
}

const PROXY_KINDS: readonly string[] = ["uups", "transparent", "beacon"];

/**
 * Whether `next` can replace `old` behind a proxy. `old.kind` is the kind of
 * the proxy being upgraded (`beacon` when a beacon serves it): taking it from
 * `next` would let a UUPS implementation that lost its upgrade function pass.
 * `old` may be a `SourceAnalysis`, or a `LayoutRecord` with its `kind` given.
 * With `skipSafety`, `next` may be a record too, and `old.kind` is not needed.
 */
export function checkUpgrade(
  old: UpgradeSide & { kind: ProxyKind },
  next: SourceAnalysis,
  options?: UpgradeOptions,
): UpgradeCheck;
export function checkUpgrade(
  old: UpgradeSide & { kind?: ProxyKind },
  next: UpgradeSide,
  options: UpgradeOptions & { skipSafety: true },
): UpgradeCheck;
export function checkUpgrade(
  old: UpgradeSide & { kind?: ProxyKind },
  next: UpgradeSide & { safety?: SourceAnalysis["safety"] },
  options: UpgradeOptions = {},
): UpgradeCheck {
  if (!options.skipSafety) {
    // Checked here for JavaScript callers: OpenZeppelin treats an unknown kind as uups.
    if (!PROXY_KINDS.includes(old.kind as string)) {
      throw new Error(
        `checkUpgrade needs the kind of the proxy being upgraded (${PROXY_KINDS.join(", ")}), ` +
          `got ${JSON.stringify(old.kind)}.`,
      );
    }
    if (typeof next.safety !== "function") {
      throw new Error("checkUpgrade needs an analysis of next (analyzeSource), or skipSafety.");
    }
  }
  // OpenZeppelin matches namespaces by annotation; pairing them by slot first
  // makes it compare the structs of the same storage.
  const namespaces = checkNamespaces(old, next);
  const layout = diffLayouts(namespaces.layout, next.layout, {
    unsafeAllowRenames: options.unsafeAllowRenames,
  });
  const safety = options.skipSafety
    ? undefined
    : next.safety!({ kind: old.kind!, unsafeAllow: options.unsafeAllow });
  // A failure outranks an unread slot, so a known problem is never reported as merely unchecked.
  const result =
    !layout.ok || namespaces.result === "fail" || safety?.ok === false
      ? "fail"
      : namespaces.result === "unread"
        ? "unchecked"
        : "pass";
  return { layout, namespaces, ...(safety !== undefined ? { safety } : {}), result };
}
