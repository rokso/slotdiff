import {
  getStorageUpgradeReport,
  withValidationDefaults,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";

/** OZ's storage comparison. `ok` is the verdict; `explain()` describes each problem. */
export type LayoutReport = ReturnType<typeof getStorageUpgradeReport>;

export interface DiffOptions {
  /** Accept renamed variables without `@custom:oz-renamed-from` (OZ's `unsafeAllowRenames`). */
  unsafeAllowRenames?: boolean;
}

/**
 * Whether `after` can safely replace `before` behind a proxy, by OZ's rules:
 * appends pass; inserts, removals, reorders and incompatible type changes
 * fail, in regular and ERC-7201 namespaced storage. Renames and retypes pass
 * when `after` approves them (`@custom:oz-renamed-from` / `oz-retyped-from`).
 */
export function diffLayouts(
  before: StorageLayout,
  after: StorageLayout,
  options: DiffOptions = {},
): LayoutReport {
  return getStorageUpgradeReport(
    before,
    after,
    withValidationDefaults({ unsafeAllowRenames: options.unsafeAllowRenames }),
  );
}
