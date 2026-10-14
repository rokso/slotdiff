# Security policy

slotdiff decides whether an upgrade is safe, so a wrong "Safe to upgrade" is a security bug. So is anything that leaks an RPC URL or an API key.

## Reporting a vulnerability

Report it privately through GitHub: **Security** tab of [rokso/slotdiff](https://github.com/rokso/slotdiff/security/advisories/new) → **Report a vulnerability**. Please do not open a public issue.

Include what you ran (the command or code, the contracts or their shape) and what slotdiff said against what it should have said. I aim to reply within a week.

## What slotdiff touches

For anyone reviewing slotdiff, or the alerts a supply-chain scanner raises about it:

- **Network:** the explorer (Etherscan's v2 API, or `--explorer-url`) for verified source, the RPC endpoint you pass, and `binaries.soliditylang.org` for compilers, each checked against the published checksum. Nothing else; no telemetry.
- **Processes:** it runs the native solc binary it downloaded, found in Hardhat's cache, or that a library caller names with `solc.resolvePath`.
- **Files:** it reads your build info and sources. It writes only the compiler cache (`slotdiff/compilers` under your OS cache directory, or `cacheDir`).
- **Environment:** `ETHERSCAN_API_KEY` (sent only to Etherscan), `XDG_CACHE_HOME` or `LOCALAPPDATA` for the cache directory, and, through Node's own color detection, `NO_COLOR`, `FORCE_COLOR`, `NODE_DISABLE_COLORS`, `TERM` and `COLORTERM`.
- **Install:** slotdiff has no install scripts, and one dependency, `@openzeppelin/upgrades-core`. Two of its transitive dependencies (`keccak` and `secp256k1`, through `ethereumjs-util`) build optional native code at install (`node-gyp-build || exit 0`).

## No guarantee

slotdiff comes without warranty and its authors accept no liability for any loss, including funds; see the README's "No guarantee" section and [LICENSE](LICENSE). Reporting a problem helps everyone, but a report does not make anyone liable for an upgrade.

## Supported versions

Fixes go into the latest release only.
