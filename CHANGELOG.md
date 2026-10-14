# Changelog

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
