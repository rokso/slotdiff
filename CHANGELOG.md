# Changelog

## Unreleased

- `findBuildInfo`: reads Foundry, Hardhat 2 and Hardhat 3 build info. The build is chosen by
  content: only one whose target and imports still match the files on disk, so the stale files
  Foundry keeps after each edit are never used. Its `input` holds only what the target imports.
- Explorer errors no longer repeat fetch's error text, which can quote the request URL and with
  it the API key.

## 0.1.0-alpha.1

First release.

- `resolveProxyLayout` / `resolveLayout`: the storage layout of the code a proxy (ERC-1967 or
  beacon) runs now, rebuilt from verified standard-json source on any Etherscan-compatible explorer
  and proven against the deployed code.
- `proveLocalBuild`: a layout record from your own build, only when it is the deployed build.
- `diffLayouts`: OpenZeppelin's storage comparison, including ERC-7201 namespaced storage.
- `LayoutRecord`s are plain JSON that slotdiff never writes. Load them back with `verifyRecord`
  (checked against the chain id and deployed code) or `parseRecord` (offline).
- A match proves a layout only when the build embeds solc's metadata hash. Builds with
  `bytecodeHash: "none"` or `appendCBOR: false` are reported as `code-only` and refused.
- `getSolc`: native solc from a cache (Hardhat's included) or a checksum-verified download.
  Accepts release versions such as `0.8.24`, as Foundry's build info records them.
- `layoutFromSource` accepts build-info input from Foundry and Hardhat.
- Loads from ESM and CommonJS. Node 22.12+.
