# slotdiff

Storage layout diff for upgradeable Solidity contracts, where either side can be a local build or
the code a proxy actually runs on chain.

```sh
npx slotdiff 0xProxy src/Vault.sol:Vault --rpc $RPC_URL   # what the proxy runs vs your build
```

For example, two local versions:

```
$ npx slotdiff src/Vault.sol:Vault src/VaultBad.sol:VaultBad
old  src/Vault.sol:Vault
     out/build-info/90f317b6c0a81633.json
new  src/VaultBad.sol:VaultBad
     out/build-info/90f317b6c0a81633.json

✗ Storage layout   incompatible
    src/VaultBad.sol:4: Inserted `inserted`
      > New variables should be placed after all existing inherited variables
✓ Safety rules     no problems found (transparent proxy)

Not safe to upgrade: the storage layout is incompatible.
```

## Why

An upgrade is only safe relative to what the proxy runs **now**. Under lazy or multisig-queued
upgrades that is often not your latest build, and the tools you have compare the wrong thing:

- OpenZeppelin's `validate` compares two local builds. It has no way to know what is live.
- `cast storage <address>` prints a live layout but does not compare it with anything.
- Deployment artifacts describe the last build you deployed, not necessarily what the proxy runs.

slotdiff reads the implementation behind the proxy, rebuilds its layout from verified source, and
**proves** that source compiles to the deployed code before trusting it. It then compares with
OpenZeppelin's own rules, including ERC-7201 namespaced storage. Framework-agnostic: Foundry,
Hardhat 2 and 3, or a plain script.

## Install

```sh
npm install slotdiff
```

Node 22.13+. Works from ESM and CommonJS.

## Command line

```sh
slotdiff <old> <new> [--rpc <url>]
```

Each side is a contract in your build info (`src/Vault.sol:Vault`, or just `Vault` when only one
contract has that name) or an address: a proxy, read as the implementation it runs now, or an
implementation, such as one waiting in a multisig queue. Any mix works. An address needs `--rpc`
and `ETHERSCAN_API_KEY` (or `--explorer-url` for another explorer), since its source comes from
the explorer. The RPC is a flag because it picks the chain for each run; the key lives in the
environment because one Etherscan key covers every chain. It is sent only to Etherscan: with
`--explorer-url`, put that explorer's own key in the URL's query if it needs one.

A local side is read from the build info your tool already wrote; slotdiff does not compile your
project. Build first, from the project root or with `--root`. Foundry writes build info only with
`build_info = true` in `foundry.toml` or `forge build --build-info`. A build older than the
sources on disk is refused, never used. `--build-info <file>` names one build-info file to use as
is, such as a CI artifact from another checkout; the output then says it was not compared with the
sources on disk.

Three checks run:

- **Storage layout**, by OpenZeppelin's rules, as above, with ERC-7201 namespaces matched by the
  slot the code really uses.
- **ERC-7201 slots**: each namespace keeps its data in place and `<new>`'s annotations match its
  code (see below).
- **Safety rules** for `<new>`, OpenZeppelin's checks that it can run behind a proxy: constructors, `selfdestruct`,
  `delegatecall`, initial values, immutables and initializers (an initializer order problem is
  only a warning, as in OpenZeppelin). Source exceptions (`@custom:oz-upgrades-unsafe-allow`) are
  honored, and `--unsafe-allow <kinds>` accepts more. For an address, the verified source is
  checked. `--no-safety` skips it.

OpenZeppelin matches ERC-7201 namespaces by their `@custom:storage-location erc7201:<id>`
annotation alone. slotdiff also reads the slot the code assigns (`assembly { $.slot := LOCATION }`,
with `LOCATION` a hex constant, the ERC-7201 formula, or `erc7201("id")`) and compares namespaces by
that slot. The check fails when `<new>` would read a namespace from another slot than the
deployed code wrote it to, whatever the annotations say, and when an annotation in `<new>`
disagrees with its code. In `<old>`, already deployed, a disagreement is reported and the
namespace is matched by its real slot, so correcting a wrong annotation is not reported as a
deleted namespace. A slot slotdiff cannot read (computed at run time, say) means the upgrade
could not be checked: exit code 2.

For example, after correcting an annotation that never matched the deployed code:

```
ERC-7201 namespaces
       annotation           slot from annotation   slot in code
  old  example.vault        0xd192…a100            0x0d90…d100    ✗ annotation does not match code
  new  example.vault.real   0x0d90…d100            0x0d90…d100    ✓
       Same slot in code on both sides: the storage did not move. Compared as one namespace.

✓ Storage layout   compatible
✓ ERC-7201 slots   compared by the slot in code (see above)
✓ Safety rules     no problems found (transparent proxy)

Safe to upgrade.
```

Changing the constant to match the wrong annotation instead would move the data:

```
ERC-7201 namespaces
       annotation      slot from annotation   slot in code
  old  example.vault   0xd192…a100            0x0d90…d100    ✗ annotation does not match code
  new  example.vault   0xd192…a100            0xd192…a100    ✓
       The new code moves this namespace from 0x0d90…d100 to 0xd192…a100: its data would be left behind. Keep the slot the deployed code uses, under an annotation that matches it.

✓ Storage layout   compatible
✗ ERC-7201 slots   problems found in <new> (see above)
✓ Safety rules     no problems found (transparent proxy)

Not safe to upgrade: an ERC-7201 namespace fails the slot check.
```

The proxy kind comes from `<old>`'s implementation: UUPS when it has `upgradeTo` or
`upgradeToAndCall`, beacon for a beacon proxy, transparent otherwise. So a UUPS implementation that
lost its upgrade function, which would leave the proxy unable to upgrade again, is caught:

```
$ npx slotdiff src/UupsV1.sol:UupsV1 src/UupsV2Lost.sol:UupsV2Lost
old  src/UupsV1.sol:UupsV1
     out/build-info/fb5d5362dc531baa.json
new  src/UupsV2Lost.sol:UupsV2Lost
     out/build-info/fb5d5362dc531baa.json

✓ Storage layout   compatible
✗ Safety rules     problems found (uups proxy)
    src/UupsV2Lost.sol:3: Implementation is missing a public `upgradeTo(address)` or `upgradeToAndCall(address,bytes)` function
        Inherit UUPSUpgradeable to include one or both of these functions in your contract
        @openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol
        https://zpl.in/upgrades/error-008

Not safe to upgrade: <new> breaks the safety rules.
```

Exit codes: `0` every check ran and passed (or was skipped with `--no-safety`), `1` a check
failed, `2` something could not be checked (never reported as compatible). `slotdiff --help` lists every option.

Colors and the banner appear only on an interactive terminal, never in a pipe, a log or CI.
`NO_COLOR` turns colors off; `FORCE_COLOR` turns them on, for CI logs that render them.

## Usage

### Live proxy vs a local build

```ts
import { JsonRpcProvider } from "ethers";
import {
  diffLayouts,
  findBuildInfo,
  getSolc,
  layoutFromSource,
  resolveProxyLayout,
} from "slotdiff";

// Any object with send(method, params): an ethers JsonRpcProvider or Hardhat's network provider.
const provider = new JsonRpcProvider(process.env.RPC_URL);
const apiKey = process.env.ETHERSCAN_API_KEY;

// 1. The layout of whatever the proxy runs now, proven against its deployed code.
const live = await resolveProxyLayout(provider, "0xProxy", { explorer: { apiKey } });

// 2. The layout of the new version, from your build info (Foundry, Hardhat 2 or 3).
const build = await findBuildInfo(process.cwd(), "src/Vault.sol:Vault");
const solc = await getSolc(build.solcVersion);
const next = await layoutFromSource(build.input, solc, build.contract);

// 3. Compare.
const report = diffLayouts(live.record.layout, next);
if (!report.ok) {
  console.error(report.explain());
  process.exit(1);
}
```

`findBuildInfo` picks the build whose sources still match the files on disk, so the stale build
info Foundry keeps after each edit is never used, and its `input` holds only the target and what
it imports. Pass `{ file }` to use one file as is (for example a CI artifact). Where the build
info lives:

| Tool      | Build info                                                                                             | Contract name                       |
| --------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Foundry   | `out/build-info/*.json`, only with `build_info = true` in `foundry.toml` or `forge build --build-info` | `src/Vault.sol:Vault`               |
| Hardhat 2 | `artifacts/build-info/*.json`                                                                          | `contracts/Vault.sol:Vault`         |
| Hardhat 3 | `artifacts/build-info/<id>.json`; the compiler output is in `<id>.output.json` next to it              | `project/contracts/Vault.sol:Vault` |

With `findBuildInfo`, Hardhat 3's `project/` prefix is optional.

`explain()` gives OpenZeppelin's report, for example:

```
src/Vault.sol:7: Inserted `inserted`
  > New variables should be placed after all existing inherited variables
```

The explorer defaults to Etherscan's v2 API, where one key covers every chain it indexes. For another
Etherscan-compatible explorer, such as Blockscout, pass `{ apiUrl }` (a key is optional there).

### Safety rules and ERC-7201 slots too

`analyzeSource` is `layoutFromSource` plus OpenZeppelin's safety check and the slot each ERC-7201
namespace really uses, from one compile, as the command line runs them. Pass the kind of the proxy being upgraded, not the new contract's
own: a UUPS implementation that lost its upgrade function would otherwise look transparent and
pass.

```ts
import { analyzeSource, checkNamespaces, diffLayouts, findBuildInfo, getSolc } from "slotdiff";

async function analyze(contract: string) {
  const build = await findBuildInfo(process.cwd(), contract);
  return analyzeSource(build.input, await getSolc(build.solcVersion), build.contract);
}
const old = await analyze("src/Vault.sol:Vault");
const next = await analyze("src/VaultV2.sol:VaultV2");

// Pair ERC-7201 namespaces by the slot the code uses, as the command line does.
const slots = checkNamespaces(old, next); // result: "pass", "fail" or "unread"
const layout = diffLayouts(slots.layout, next.layout);
const safety = next.safety({ kind: old.kind }); // the kind of the proxy being upgraded
if (!layout.ok || slots.result !== "pass" || !safety.ok) {
  console.error(layout.explain(), slots.pairs, safety.explain());
}
```

`safety` also takes `unsafeAllow` (error kinds to accept, listed in `SAFETY_ERROR_KINDS`), on top
of `@custom:oz-upgrades-unsafe-allow` in the source.

### Keep records, skip the rebuild next time

Rebuilding means fetching source and compiling. A `LayoutRecord` is plain JSON: store it wherever
suits you (committed next to your deployments, a CI cache) and load it back with `verifyRecord`,
which refuses it unless this chain still runs the exact code it was proven against.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { readImplementation, resolveLayout, verifyRecord } from "slotdiff";

const impl = await readImplementation(provider, "0xProxy"); // what the proxy runs now
const path = `layouts/${impl}.json`;

let record;
try {
  record = await verifyRecord(provider, impl, JSON.parse(readFileSync(path, "utf8")));
} catch {
  record = await resolveLayout(provider, impl, { explorer: { apiKey } });
  writeFileSync(path, JSON.stringify(record, null, 2));
}
```

Key records by **implementation**, and read the implementation from the proxy every time. A record
for an old implementation still verifies after the proxy is upgraded, because that code is still
deployed at its own address.

Without an RPC, `parseRecord(value, address)` checks a record's shape and proof offline. It cannot
tell whether the proxy has moved on, so prefer `verifyRecord` whenever you can reach the chain.

A record is bound to the deployed code, not to its own `layout` field: an edited layout in a saved
record still verifies. Treat saved records as trusted input and review changes to them like code.

### No explorer: prove your own build

If you deployed it yourself, your build can serve as the source. `proveLocalBuild` compares the
deployed code with your compiler output and returns a record only when they prove to be the same
build.

```ts
import { findBuildInfo, getSolc, layoutFromSource, proveLocalBuild } from "slotdiff";

const build = await findBuildInfo(process.cwd(), "src/Vault.sol:Vault");
const solc = await getSolc(build.solcVersion);
const { bytecodeMatch, record } = await proveLocalBuild(provider, impl, {
  contract: build.contract,
  compiler: solc.longVersion,
  layout: await layoutFromSource(build.input, solc, build.contract),
  deployedBytecode: build.deployedBytecode!,
  immutableReferences: build.immutableReferences,
});
if (record === undefined) throw new Error(`Not the deployed build (${bytecodeMatch})`);
```

## What counts as proof

A layout is only trusted when the compiled code matches the deployed code as `exact` or
`immutables-only` (identical once immutables and library addresses are masked), **and** the build
embeds solc's metadata hash. That hash covers every source file and setting, so matching code then
means matching source.

Anything weaker is refused, because variables no code reads, retyped fields and gap sizes never
reach the bytecode, so a different layout can compile to the same code:

| Match             | Meaning                                                                 | Proof? |
| ----------------- | ----------------------------------------------------------------------- | ------ |
| `exact`           | Byte-identical                                                          | Yes    |
| `immutables-only` | Identical once immutables and library links are masked                  | Yes    |
| `metadata-only`   | Identical only after stripping metadata: the source differed            | No     |
| `code-only`       | Identical, but built with `bytecodeHash: "none"` or `appendCBOR: false` | No     |
| `none`            | Different code                                                          | No     |

Contracts built without a metadata hash (common for deterministic CREATE2 deployments) therefore
cannot be proven. For explorer source, the verified compiler settings are checked as well, so a
build without a hash is refused even if its code happens to end in bytes shaped like one. With
`proveLocalBuild`, the hash is read from your own compiler output.

## Errors

slotdiff fails closed: it never treats "could not check" as "safe".

- `LayoutUnavailableError`: no answer. Not a proxy, unverified source, explorer outage or rate
  limit, no compiler for the platform. Falling back to another source is reasonable.
- `LayoutIntegrityError`: an answer that cannot be trusted. Source that does not compile to the
  deployed code, a weak match, a record from another chain or for other code. Never fall back on
  this one.

A few problems that are yours to fix throw a plain `Error`: a rejected explorer API key, a compiler
binary that fails to run (for example the wrong architecture), and a record in a format from a
newer slotdiff.

## API

| Export                                                       | Purpose                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `diffLayouts(before, after, { unsafeAllowRenames? })`        | OpenZeppelin's storage comparison. `ok` and `explain()`                  |
| `resolveProxyLayout(provider, proxy, options)`               | Proven layout of what a proxy (ERC-1967 or beacon) runs now              |
| `resolveLayout(provider, address, options)`                  | Proven layout of the code at an implementation address                   |
| `proveLocalBuild(provider, address, build)`                  | A record from your own build, only when it is the deployed build         |
| `verifyRecord(provider, address, value)`                     | Load a saved record, checked against the chain                           |
| `parseRecord(value, address?)`                               | Load a saved record, checked offline                                     |
| `layoutFromSource(input, solc, "file.sol:Name")`             | Layout from standard-json input, including ERC-7201 namespaces. No proof |
| `analyzeSource(input, solc, "file.sol:Name")`                | The layout, proxy `kind`, ERC-7201 `namespaces` and `safety({ kind })`   |
| `checkNamespaces(old, next)`                                 | ERC-7201 namespaces paired by real slot; a moved one fails               |
| `findBuildInfo(root, contract, { file? })`                   | Your build info for a contract: input, compiler version, deployed code   |
| `getSolc(version)`                                           | Native solc, from a cache or downloaded and checksum-verified            |
| `readProxy`, `readImplementation`, `readCode`, `readChainId` | Chain reads                                                              |
| `fetchVerifiedSource(chainId, address, explorer)`            | Verified standard-json source from an Etherscan-compatible explorer      |
| `compareDeployedBytecode`, `isProvingMatch`                  | The match classification above                                           |

`getSolc` takes a long (`0.8.24+commit.e11b9ed9`) or release (`0.8.24`) version. Compilers are
cached under your OS cache directory (`slotdiff/compilers`, or `cacheDir`), and Hardhat's compiler
cache is reused when present.

Renames and retypes follow OpenZeppelin's NatSpec tags, `@custom:oz-renamed-from` and
`@custom:oz-retyped-from`.

## Limitations

- Explorer source must be verified as standard-json. Flattened and multi-file verifications do not
  record every compiler setting, so they are refused.
- Solidity only.
- Struct members cannot be renamed or retyped: Solidity has no NatSpec on struct members, so
  OpenZeppelin's tags cannot reach them.
- An ERC-7201 slot is read only from a `$.slot := ...` assignment whose value is a constant (a hex
  literal, the ERC-7201 formula, or `erc7201("id")`), directly or through a local variable set
  once or a function with no arguments that returns one. Any other slot (computed at run time, a
  library's constant) is not read, and the upgrade is reported as not checked.

## License

MIT
