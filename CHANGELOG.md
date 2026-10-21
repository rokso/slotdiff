# Changelog

## Unreleased

- `analyzeBuild(input, output, compiler)`: `analyzeSource` for a build already compiled (a build tool's), with no second full compile; one namespaced pass serves every contract. Its `metadata` must prove the output was compiled from those sources by that compiler, so output from another build is refused (`LayoutIntegrityError`); incomplete output throws the new `IncompleteBuildError`.
- `checkUpgrade(old, next, options?)`: layout, ERC-7201 slots and safety rules in one verdict (`pass`, `fail` or `unchecked`), as the CLI runs them. The proxy kind comes from `old`.
- Layout records keep the proxy `kind` and each namespace's slot (`namespaces`), so a saved record can stand in for `old`. Optional: older records still load.
- `checkNamespaces`: a namespace missing from `namespaces` (an older record) is unread, never matched by annotation alone; slots that do not fit the layout are refused. **Breaking:** `next` needs its `layout`.
- ERC-7201: a namespace with no `$.slot :=` assignment (kept reserved) is `unused` and compared by its annotation (unless the code places another struct at a known slot, or a mapping or an array pointer), instead of making every upgrade of such a contract exit 2. Dropping the last assignment of a namespace whose deployed annotation is wrong fails (`dropped`), while the real slot is still known. **Breaking:** `NamespaceSlot.status` adds `"unused"` (such namespaces were `unread`).
- `SafetyReport.explain(color?)` and `NamespaceCheck.explain(color?)` (the CLI's namespace grid); `safety()` refuses an unknown `unsafeAllow` kind; `resolveProxyLayout` returns the proxy's `kind`; `proveLocalBuild` takes `kind` and `namespaces` for the record. New types: `SolcOutput`, `UpgradeSide`, `UpgradeOptions`, `UpgradeCheck`, `BuildAnalysis`, `BuildCompiler`.
- `analyzeSource` checks its own compile as `analyzeBuild` does: it refuses an input source without `content` (such as `urls`), and a compiler whose version differs from the one the metadata names (`LayoutIntegrityError`).
- `parseRecord` refuses a namespace key not of the form `<formula>:<id>`, and a malformed `kind` or `namespaces`.
- CLI: namespaces with no problem that the code does not assign are left out of the grid, and the summary counts them ("N not assigned in code, compared by annotation"); an unread slot says which side could not be read.
- CLI: an `<old>` address that is not an ERC-1967 or beacon proxy is refused (exit 2) unless `--old-implementation` says it is an implementation. In 0.2.0 it was taken as an implementation, so a proxy of another kind (a custom slot, a diamond) was compared as its own, nearly empty, code and could pass. **Breaking** for an `<old>` implementation address: add `--old-implementation`.
- solc runs in a new empty directory. Since 0.1.0 it ran in the caller's, so verified source could `import` a file under it (an `.env`, say) and solc would quote its first line in the compile error. Verified source given by `urls` instead of inline `content` is refused.
- Text from an explorer or from verified source can no longer move the cursor, recolor the terminal or draw lines of its own: control characters are stripped from solc's errors, explorer messages are kept on one line, and verified source with control characters in its name, paths or text (tabs and line breaks in text aside), or any whitespace but a space in its name and paths, is refused (`LayoutUnavailableError`).
- `getSolc` refuses a malformed entry in solc's build list before it becomes a path. The publish workflow installs dependencies without their install scripts; a weekly workflow tests against the newest OpenZeppelin upgrades-core 1.x.
- **Breaking:** a contract missing from the compiler input throws a plain `Error` (was `LayoutIntegrityError`), as a wrong argument; `NamespacePair.problem` adds `"dropped"`; `NamespaceCheck.result` says `"unchecked"` (was `"unread"`), as `UpgradeCheck.result` does; `layoutFromSource` is removed (use `(await analyzeSource(input, solc, contract)).layout`, at the same cost).
- `SAFETY_ERROR_KINDS` and `SafetyErrorKind` are slotdiff's own list (a test compares it with OpenZeppelin's), so the published types no longer import an OpenZeppelin internal file.

## 0.2.0-alpha.1

- CLI: `slotdiff <old> <new>`, where each side is a contract in your build info or an address (a proxy, read as what it runs now, or an implementation; needs `--rpc` and `ETHERSCAN_API_KEY`). Checks the storage layout, the ERC-7201 slots and OpenZeppelin's safety rules for `<new>`, with the proxy kind taken from `<old>`'s implementation, so a UUPS implementation missing `upgradeToAndCall` fails. Exits 0 when every check passed, 1 when one failed, 2 when something could not be checked. `ETHERSCAN_API_KEY` is sent only to Etherscan, never to `--explorer-url`.
- `findBuildInfo`: reads Foundry, Hardhat 2 and Hardhat 3 build info. The build is chosen by content: only one whose target and imports still match the files on disk, so the stale files Foundry keeps after each edit are never used. Its `input` holds only what the target imports.
- ERC-7201 namespaces are compared by the slot the code really uses, not only the annotation: a namespace whose slot moves fails, whatever the annotations say, and a corrected annotation over an unchanged slot passes (`SourceAnalysis.namespaces`, `checkNamespaces`).
- `analyzeSource`: `layoutFromSource` plus OpenZeppelin's safety check from one compile, as the CLI runs it; `safety({ kind })` takes the proxy kind being upgraded.
- Explorer errors no longer repeat fetch's error text, which can quote the request URL and with it the API key.
- CLI colors and a banner on an interactive terminal only (on runs, `--help` and `--version`); in a pipe or CI the output stays plain and `--version` prints just the version. `NO_COLOR` and `FORCE_COLOR` are honored. Built on Node's `util.styleText`, so no new dependency.
- **Breaking:** Node 22.13+ (was 22.12+), for `util.styleText`'s terminal detection.
- Releases are published from GitHub Actions through npm trusted publishing, staged for a maintainer's 2FA approval, with a provenance attestation linking each version to its commit.
- `SECURITY.md`: how to report a vulnerability privately, and what slotdiff touches (network, processes, files, environment). The README and `--help` now say plainly that a pass is no guarantee and that slotdiff comes without warranty.

## 0.1.0-alpha.1

First release.

- `resolveProxyLayout` / `resolveLayout`: the storage layout of the code a proxy (ERC-1967 or beacon) runs now, rebuilt from verified standard-json source on any Etherscan-compatible explorer and proven against the deployed code.
- `proveLocalBuild`: a layout record from your own build, only when it is the deployed build.
- `diffLayouts`: OpenZeppelin's storage comparison, including ERC-7201 namespaced storage.
- `LayoutRecord`s are plain JSON that slotdiff never writes. Load them back with `verifyRecord` (checked against the chain id and deployed code) or `parseRecord` (offline).
- A match proves a layout only when the build embeds solc's metadata hash. Builds with `bytecodeHash: "none"` or `appendCBOR: false` are reported as `code-only` and refused.
- `getSolc`: native solc from a cache (Hardhat's included) or a checksum-verified download. Accepts release versions such as `0.8.24`, as Foundry's build info records them.
- `layoutFromSource` accepts build-info input from Foundry and Hardhat.
- Loads from ESM and CommonJS. Node 22.12+.
