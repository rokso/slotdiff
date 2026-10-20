# slotdiff

[![npm](https://img.shields.io/npm/v/slotdiff)](https://www.npmjs.com/package/slotdiff) [![CI](https://github.com/rokso/slotdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/rokso/slotdiff/actions/workflows/ci.yml) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/rokso/slotdiff/badge)](https://scorecard.dev/viewer/?uri=github.com/rokso/slotdiff) [![License: MIT](https://img.shields.io/npm/l/slotdiff)](LICENSE)

Storage layout diff for upgradeable Solidity contracts, where either side can be a local build or the code a proxy actually runs on chain.

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

An upgrade is only safe relative to what the proxy runs **now**. Under lazy or multisig-queued upgrades that is often not your latest build, and the tools you have compare the wrong thing:

- OpenZeppelin's `validate` compares two local builds. It has no way to know what is live.
- `cast storage <address>` prints a live layout but does not compare it with anything.
- Deployment artifacts describe the last build you deployed, not necessarily what the proxy runs.

slotdiff reads the implementation behind the proxy, rebuilds its layout from verified source, and **proves** that source compiles to the deployed code before trusting it. It then compares with OpenZeppelin's own rules, including ERC-7201 namespaced storage. Framework-agnostic: Foundry, Hardhat 2 and 3, or a plain script.

## Install

```sh
npm install slotdiff
```

Node 22.13+. Works from ESM and CommonJS.

## Command line

```sh
slotdiff <old> <new> [--rpc <url>]
```

Each side is a contract in your build info (`src/Vault.sol:Vault`, or just `Vault` when only one contract has that name) or an address: a proxy (ERC-1967 or beacon), read as the implementation it runs now, or for `<new>` an implementation, such as one waiting in a multisig queue. Any mix works. An `<old>` address that is not such a proxy is refused, since a proxy of another kind (a diamond, a custom slot) would be compared as its own code: pass `--old-implementation` when `<old>` is an implementation, or give such a proxy by its implementation's address. An address needs `--rpc` and `ETHERSCAN_API_KEY` (or `--explorer-url` for another explorer), since its source comes from the explorer. The RPC is a flag because it picks the chain for each run; the key lives in the environment because one Etherscan key covers every chain. It is sent only to Etherscan: with `--explorer-url`, put that explorer's own key in the URL's query if it needs one.

A local side is read from the build info your tool already wrote; slotdiff does not compile your project. Build first, from the project root or with `--root`. Foundry writes build info only with `build_info = true` in `foundry.toml` or `forge build --build-info`. A build older than the sources on disk is refused, never used. `--build-info <file>` names one build-info file to use as is, such as a CI artifact from another checkout; the output then says it was not compared with the sources on disk.

Three checks run:

- **Storage layout**, by OpenZeppelin's rules, as above, with ERC-7201 namespaces matched by the slot the code really uses.
- **ERC-7201 slots**: each namespace keeps its data in place and `<new>`'s annotations match its code (see below).
- **Safety rules** for `<new>`, OpenZeppelin's checks that it can run behind a proxy: constructors, `selfdestruct`, `delegatecall`, initial values, immutables and initializers (an initializer order problem is only a warning, as in OpenZeppelin). Source exceptions (`@custom:oz-upgrades-unsafe-allow`) are honored, and `--unsafe-allow <kinds>` accepts more. For an address, the verified source is checked. `--no-safety` skips it.

OpenZeppelin matches ERC-7201 namespaces by their `@custom:storage-location erc7201:<id>` annotation alone. slotdiff also reads the slot the code assigns (`assembly { $.slot := LOCATION }`, with `LOCATION` a hex constant, the ERC-7201 formula, or `erc7201("id")`) and compares namespaces by that slot. The check fails when `<new>` would read a namespace from another slot than the deployed code wrote it to, whatever the annotations say, and when an annotation in `<new>` disagrees with its code. In `<old>`, already deployed, a disagreement is reported and the namespace is matched by its real slot, so correcting a wrong annotation is not reported as a deleted namespace. A namespace with no `$.slot := ...` assignment (one kept reserved, as OpenZeppelin advises for a struct no longer used) is compared by its annotation, as OpenZeppelin does. Dropping the last assignment of a namespace whose deployed annotation does not match its data fails: correct the annotation first, since later versions would be compared by it (correcting it and dropping the assignment in the same upgrade fails too). A slot slotdiff cannot read (set from a value it does not evaluate, such as one computed at run time) means the upgrade could not be checked: exit code 2.

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

The proxy kind comes from `<old>`'s implementation: UUPS when it has `upgradeTo` or `upgradeToAndCall`, beacon for a beacon proxy, transparent otherwise. So a UUPS implementation that lost its upgrade function, which would leave the proxy unable to upgrade again, is caught:

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

Exit codes: `0` every check ran and passed (or was skipped with `--no-safety`), `1` a check failed, `2` something could not be checked (never reported as compatible). `slotdiff --help` lists every option.

Colors and the banner appear only on an interactive terminal, never in a pipe, a log or CI. `NO_COLOR` turns colors off; `FORCE_COLOR` turns them on, for CI logs that render them.

## Usage

### Live proxy vs a local build

```ts
import { JsonRpcProvider } from "ethers";
import { analyzeSource, checkUpgrade, findBuildInfo, getSolc, resolveProxyLayout } from "slotdiff";

// Any object with send(method, params): an ethers JsonRpcProvider or Hardhat's network provider.
const provider = new JsonRpcProvider(process.env.RPC_URL);
const apiKey = process.env.ETHERSCAN_API_KEY;

// 1. Whatever the proxy runs now: its layout and ERC-7201 slots, proven against its deployed code.
const live = await resolveProxyLayout(provider, "0xProxy", { explorer: { apiKey } });

// 2. The new version, from your build info (Foundry, Hardhat 2 or 3).
const build = await findBuildInfo(process.cwd(), "src/VaultV2.sol:VaultV2");
const next = await analyzeSource(build.input, await getSolc(build.solcVersion), build.contract);

// 3. The layout, the ERC-7201 slots and the safety rules, with the proxy's own kind.
const check = checkUpgrade({ ...live.record, kind: live.kind }, next);
if (check.result !== "pass") {
  // "fail", or "unchecked" when an ERC-7201 slot could not be read: neither is a pass.
  console.error(check.layout.explain(), check.namespaces.explain(), check.safety?.explain());
  process.exit(1);
}
```

`findBuildInfo` picks the build whose sources still match the files on disk, so the stale build info Foundry keeps after each edit is never used, and its `input` holds only the target and what it imports. Pass `{ file }` to use one file as is (for example a CI artifact). Where the build info lives:

| Tool | Build info | Contract name |
| --- | --- | --- |
| Foundry | `out/build-info/*.json`, only with `build_info = true` in `foundry.toml` or `forge build --build-info` | `src/Vault.sol:Vault` |
| Hardhat 2 | `artifacts/build-info/*.json` | `contracts/Vault.sol:Vault` |
| Hardhat 3 | `artifacts/build-info/<id>.json`; the compiler output is in `<id>.output.json` next to it | `project/contracts/Vault.sol:Vault` |

With `findBuildInfo`, Hardhat 3's `project/` prefix is optional.

`check.layout.explain()` gives OpenZeppelin's report, for example:

```
src/Vault.sol:7: Inserted `inserted`
  > New variables should be placed after all existing inherited variables
```

The explorer defaults to Etherscan's v2 API, where one key covers every chain it indexes. For another Etherscan-compatible explorer, such as Blockscout, pass `{ apiUrl }` (a key is optional there).

### Two local builds

`analyzeSource` gives a contract's layout, the slot each ERC-7201 namespace really uses and OpenZeppelin's safety check, from one compile. `checkUpgrade` runs all three checks on two analyses, or a record and an analysis, and gives one verdict, as the command line does.

```ts
import { analyzeSource, checkUpgrade, findBuildInfo, getSolc } from "slotdiff";

async function analyze(contract: string) {
  const build = await findBuildInfo(process.cwd(), contract);
  return analyzeSource(build.input, await getSolc(build.solcVersion), build.contract);
}
const old = await analyze("src/Vault.sol:Vault");
const next = await analyze("src/VaultV2.sol:VaultV2");

const check = checkUpgrade(old, next); // result: "pass", "fail" or "unchecked"
if (check.result !== "pass") {
  console.error(check.layout.explain(), check.namespaces.explain(), check.safety?.explain());
}
```

The safety rules take the proxy kind from `old`, the proxy being upgraded, never from `next`: a UUPS implementation that lost its upgrade function would otherwise look transparent and pass. For a beacon proxy, pass `{ ...old, kind: "beacon" }`. `checkUpgrade` also takes `unsafeAllowRenames`, `unsafeAllow` (error kinds to accept, listed in `SAFETY_ERROR_KINDS`, on top of `@custom:oz-upgrades-unsafe-allow` in the source) and `skipSafety`. `unchecked` means nothing failed but an ERC-7201 slot could not be read (`check.namespaces.result` is `unread`). With `skipSafety`, `pass` covers the layout and slots only, and `check.safety` is absent. The pieces are there too: `checkNamespaces`, `diffLayouts` and the analysis's own `safety({ kind })`.

### Reuse a build you already compiled

A build tool has just compiled the project, so compiling it again only to analyze it is wasted time. `analyzeBuild` takes that compiler input and output and analyzes every contract in it from one more, much lighter pass (OpenZeppelin's namespaced layouts). The output needs every source's `ast` and each contract's `metadata`, `storageLayout` and `evm.bytecode` (`object`, `linkReferences`); an interface or library may lack a `storageLayout`. Ask for them in `outputSelection` (Hardhat 3 leaves out `metadata` and `storageLayout` by default, Hardhat 2 `storageLayout`; Foundry needs `extra_output = ["storageLayout"]`). Output missing any of these throws `IncompleteBuildError`, so a build tool can ask for a fresh compile. The metadata proves the output was compiled from these sources by this compiler version (not that it used the input's settings, so pass the input the build tool compiled): an output from an earlier build is refused, never half analyzed. Hardhat 3 wraps the output in `<id>.output.json`; pass its `output` field.

```ts
import { analyzeBuild, checkUpgrade, getSolc } from "slotdiff";

const build = await analyzeBuild(input, output, await getSolc(solcLongVersion));
const check = checkUpgrade(old, build.contract("project/contracts/Vault.sol:Vault"));
```

The third argument runs that pass: a `getSolc` compiler, or your build tool's own, as `{ longVersion, compile(input) }`.

### Keep records, skip the rebuild next time

Rebuilding means fetching source and compiling. A `LayoutRecord` is plain JSON: store it wherever suits you (committed next to your deployments, a CI cache) and load it back with `verifyRecord`, which refuses it unless this chain still runs the exact code it was proven against.

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

Key records by **implementation**, and read the implementation from the proxy every time. A record for an old implementation still verifies after the proxy is upgraded, because that code is still deployed at its own address.

A record also keeps the proxy `kind` its code implies and the slot each ERC-7201 namespace really uses (`namespaces`), so it can stand in for `old` in `checkUpgrade`. Pass the proxy's own kind when you know it: `resolveProxyLayout` returns it as `kind` (`beacon` behind a beacon). Otherwise fall back to `"uups"`, never `"transparent"`: `"uups"` only adds the requirement that `next` keeps its upgrade function, so at worst it fails a transparent proxy's upgrade, while `"transparent"` would pass a UUPS implementation that lost it.

```ts
const check = checkUpgrade({ ...record, kind: record.kind ?? "uups" }, next);
```

Older records have neither field, and their namespaces come out unchecked rather than trusted by annotation. To compare two records, as a deploy step might, pass `{ skipSafety: true }`: `next` then needs no analysis and `old` no kind.

Without an RPC, `parseRecord(value, address)` checks a record's shape and proof offline. It cannot tell whether the proxy has moved on, so prefer `verifyRecord` whenever you can reach the chain.

A record is bound to the deployed code, not to what it says about that code: an edited `layout`, `kind` or `namespaces` in a saved record still verifies. Each changes the verdict (an edited `kind` of `"transparent"` drops the check that a UUPS implementation keeps its upgrade function). Treat saved records as trusted input and review changes to them like code.

### No explorer: prove your own build

If you deployed it yourself, your build can serve as the source. `proveLocalBuild` compares the deployed code with your compiler output and returns a record only when they prove to be the same build.

```ts
import { analyzeSource, findBuildInfo, getSolc, proveLocalBuild } from "slotdiff";

const build = await findBuildInfo(process.cwd(), "src/Vault.sol:Vault");
const solc = await getSolc(build.solcVersion);
const { layout, kind, namespaces } = await analyzeSource(build.input, solc, build.contract);
const { bytecodeMatch, record } = await proveLocalBuild(provider, impl, {
  contract: build.contract,
  compiler: solc.longVersion,
  layout,
  kind, // so the record can stand in for `old` in checkUpgrade
  namespaces,
  deployedBytecode: build.deployedBytecode!,
  immutableReferences: build.immutableReferences,
});
if (record === undefined) throw new Error(`Not the deployed build (${bytecodeMatch})`);
```

## What counts as proof

A layout is only trusted when the compiled code matches the deployed code as `exact` or `immutables-only` (identical once immutables and library addresses are masked), **and** the build embeds solc's metadata hash. That hash covers every source file and setting, so matching code then means matching source.

Anything weaker is refused, because variables no code reads, retyped fields and gap sizes never reach the bytecode, so a different layout can compile to the same code:

| Match | Meaning | Proof? |
| --- | --- | --- |
| `exact` | Byte-identical | Yes |
| `immutables-only` | Identical once immutables and library links are masked | Yes |
| `metadata-only` | Identical only after stripping metadata: the source differed | No |
| `code-only` | Identical, but built with `bytecodeHash: "none"` or `appendCBOR: false` | No |
| `none` | Different code | No |

Contracts built without a metadata hash (common for deterministic CREATE2 deployments) therefore cannot be proven. For explorer source, the verified compiler settings are checked as well, so a build without a hash is refused even if its code happens to end in bytes shaped like one. With `proveLocalBuild`, the hash is read from your own compiler output.

## Errors

slotdiff fails closed: it never treats "could not check" as "safe".

- `LayoutUnavailableError`: no answer. Not a proxy, unverified source, explorer outage or rate limit, no compiler for the platform. Falling back to another source is reasonable.
- `LayoutIntegrityError`: an answer that cannot be trusted. Source that does not compile to the deployed code, a weak match, a record from another chain or for other code, a record or analysis that contradicts itself (namespace slots that do not fit its layout). Never fall back on this one.

Problems that are yours to fix throw a plain `Error`, or `IncompleteBuildError` (an `Error`) for a build missing output `analyzeBuild` needs: a rejected explorer API key, a compiler binary that fails to run (for example the wrong architecture), a record in a format from a newer slotdiff, and wrong arguments, such as a contract that is not in the compiler input, an unknown proxy kind given to `checkUpgrade`, an unknown `unsafeAllow` kind, or `checkUpgrade` asked for the safety rules without an analysis of `next`.

## API

| Export | Purpose |
| --- | --- |
| `diffLayouts(before, after, { unsafeAllowRenames? })` | OpenZeppelin's storage comparison. `ok` and `explain()` |
| `resolveProxyLayout(provider, proxy, options)` | Proven layout of what a proxy (ERC-1967 or beacon) runs now |
| `resolveLayout(provider, address, options)` | Proven layout of the code at an implementation address |
| `proveLocalBuild(provider, address, build)` | A record from your own build, only when it is the deployed build |
| `verifyRecord(provider, address, value)` | Load a saved record, checked against the chain |
| `parseRecord(value, address?)` | Load a saved record, checked offline |
| `layoutFromSource(input, solc, "file.sol:Name")` | Layout from standard-json input, including ERC-7201 namespaces. No proof |
| `analyzeSource(input, solc, "file.sol:Name")` | The layout, proxy `kind`, ERC-7201 `namespaces` and `safety({ kind })` |
| `analyzeBuild(input, output, compiler)` | The same for every contract of a build already compiled, with no second full compile |
| `checkUpgrade(old, next, options?)` | Layout, ERC-7201 slots and safety rules in one verdict: `pass`, `fail` or `unchecked` |
| `checkNamespaces(old, next)` | ERC-7201 namespaces paired by real slot; a moved one fails. `explain()` |
| `findBuildInfo(root, contract, { file? })` | Your build info for a contract: input, compiler version, deployed code |
| `getSolc(version)` | Native solc, from a cache or downloaded and checksum-verified |
| `readProxy`, `readImplementation`, `readCode`, `readChainId` | Chain reads |
| `fetchVerifiedSource(chainId, address, explorer)` | Verified standard-json source from an Etherscan-compatible explorer |
| `compareDeployedBytecode`, `isProvingMatch` | The match classification above |

`getSolc` takes a long (`0.8.24+commit.e11b9ed9`) or release (`0.8.24`) version. Compilers are cached under your OS cache directory (`slotdiff/compilers`, or `cacheDir`), and Hardhat's compiler cache is reused when present.

Renames and retypes follow OpenZeppelin's NatSpec tags, `@custom:oz-renamed-from` and `@custom:oz-retyped-from`.

## Limitations

- Explorer source must be verified as standard-json. Flattened and multi-file verifications do not record every compiler setting, so they are refused.
- Solidity only.
- Struct members cannot be renamed or retyped: Solidity has no NatSpec on struct members, so OpenZeppelin's tags cannot reach them.
- An ERC-7201 slot is read only from a `$.slot := ...` assignment whose value is a constant (a hex literal, the ERC-7201 formula, or `erc7201("id")`), directly or through a local variable set once or a function with no arguments that returns one. Any other slot (computed at run time, a library's constant) is not read, and the upgrade is reported as not checked. A namespace with no `$.slot := ...` assignment is compared by its annotation alone, as with OpenZeppelin, unless the code places a struct without an annotation (a library's `Layout`, say) at a slot it can read, or a mapping or an array pointer anywhere: its data may live there, so the upgrade is reported as not checked. Data an even older version left at another slot, or data reached another way (raw `sload` and `sstore`, or a pointer whose slot is passed in, as OpenZeppelin's `StorageSlot` takes it), goes unnoticed.

## No guarantee

slotdiff is provided as is, without warranty of any kind (see [LICENSE](LICENSE)). It checks what its rules and OpenZeppelin's can check. "Safe to upgrade" means those checks found no problem, not that the upgrade is safe in every way. It does not replace review, a test upgrade on a fork, or an audit. The authors accept no liability for any loss, including lost or locked funds, arising from using slotdiff or relying on its results.

To report a security problem, or to see what slotdiff touches on your machine (network, processes, files, environment), read [SECURITY.md](SECURITY.md).

## License

MIT
