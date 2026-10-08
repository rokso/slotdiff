/**
 * A saved layout record is bound to the chain and code it was proven against.
 * One copied from another chain, loaded for another address, left over from
 * different code at the same address, or resting on a match that does not
 * prove a layout is refused rather than served.
 */
import { describe, it, expect } from "vitest";

import { parseRecord, verifyRecord, type LayoutRecord } from "../src/record.js";
import { codeSha256 } from "../src/chain.js";
import { LayoutIntegrityError, LayoutUnavailableError } from "../src/errors.js";
import { resolveLayout, proveLocalBuild } from "../src/resolve.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const IMPL = "0x00000000000000000000000000000000000000bb";
const OTHER_ADDRESS = "0x00000000000000000000000000000000000000cc";
// solc's default CBOR metadata (an ipfs hash), so an identical build proves its source.
const METADATA = "a2646970667358221220" + "12".repeat(32) + "64736f6c6343000818" + "0033";
const PROVEN = "0x6080604052" + "11".repeat(32) + METADATA;
const OTHER = "0x6080604052" + "22".repeat(32) + METADATA;

const record = (over: Record<string, unknown> = {}): LayoutRecord =>
  ({
    format: 1,
    address: IMPL,
    chainId: 1,
    codeSha256: codeSha256(PROVEN),
    contract: "a.sol:A",
    bytecodeMatch: "exact",
    source: "local-compile",
    recordedAt: "2026-01-01T00:00:00.000Z",
    layout: { storage: [], types: {} },
    ...over,
  }) as LayoutRecord;

const saved = (over: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(record(over)));

describe("verifyRecord", () => {
  it("serves a record when the chain has the code it was proven against", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    expect(await verifyRecord(provider, IMPL.toUpperCase().replace("0X", "0x"), saved())).toEqual(
      record(),
    );
  });

  it("refuses a record when the chain has other code at that address", async () => {
    const provider = makeMockChain({ code: { [IMPL]: OTHER } });
    const err = await verifyRecord(provider, IMPL, saved()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/proven against different code/);
  });

  it("refuses a record made on another chain, even for the same code", async () => {
    const provider = makeMockChain({ chainId: 5, code: { [IMPL]: PROVEN } });
    await expect(verifyRecord(provider, IMPL, saved())).rejects.toThrow(
      /made on chain 1, not on chain 5/,
    );
  });

  it("refuses a record loaded for another address, even when both run the same code", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN, [OTHER_ADDRESS]: PROVEN } });
    const err = await verifyRecord(provider, OTHER_ADDRESS, saved()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LayoutIntegrityError);
    expect((err as Error).message).toMatch(/was loaded for/);
  });
});

describe("parseRecord", () => {
  it.each(["metadata-only", "none"])("refuses a record resting on a %s match", (match) => {
    expect(() => parseRecord(saved({ bytecodeMatch: match }))).toThrow(/does not prove/);
  });

  it("refuses an unknown format, naming the fix", () => {
    expect(() => parseRecord(saved({ format: 2 }))).toThrow(/upgrade slotdiff/);
  });

  it.each([
    ["address", { address: "0xBB" }],
    ["address", { address: IMPL.toUpperCase().replace("0X", "0x") }],
    ["chainId", { chainId: "1" }],
    ["codeSha256", { codeSha256: "abc" }],
    ["contract", { contract: "A" }],
    ["source", { source: "guess" }],
    ["layout", { layout: { storage: {} } }],
  ])("refuses a malformed %s", (field, change) => {
    expect(() => parseRecord(saved(change))).toThrow(new RegExp(`malformed ${field}`));
  });

  it("refuses a non-object", () => {
    expect(() => parseRecord(null)).toThrow(LayoutIntegrityError);
  });
});

describe("resolveLayout", () => {
  it("refuses to start without an explorer it can query", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    await expect(resolveLayout(provider, IMPL, { explorer: {} })).rejects.toThrow(
      LayoutUnavailableError,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("proveLocalBuild", () => {
  const build = { contract: "a.sol:A", layout: { storage: [], types: {} } };

  it("gives a record that verifies when the chain runs the build", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    const { bytecodeMatch, record } = await proveLocalBuild(provider, IMPL, {
      ...build,
      deployedBytecode: PROVEN,
    });
    expect(bytecodeMatch).toBe("exact");
    expect(await verifyRecord(provider, IMPL, JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it("gives no record when the chain runs other code", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    const result = await proveLocalBuild(provider, IMPL, { ...build, deployedBytecode: OTHER });
    expect(result).toEqual({ bytecodeMatch: "none" });
  });
});

describe("verifyRecord when the code is gone", () => {
  it("refuses as an integrity failure, so callers never fall back", async () => {
    const provider = makeMockChain({ code: {} });
    await expect(verifyRecord(provider, IMPL, saved())).rejects.toThrow(LayoutIntegrityError);
  });
});

describe("proveLocalBuild without a source hash", () => {
  it("gives no record for identical code that carries no source hash", async () => {
    const unhashed = "0x6080604052" + "11".repeat(32) + "a164736f6c6343000818000a";
    const provider = makeMockChain({ code: { [IMPL]: unhashed } });
    const result = await proveLocalBuild(provider, IMPL, {
      contract: "a.sol:A",
      layout: { storage: [], types: {} },
      deployedBytecode: unhashed,
    });
    expect(result).toEqual({ bytecodeMatch: "code-only" });
  });

  it("refuses to make a record that would not load back", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    await expect(
      proveLocalBuild(provider, IMPL, {
        contract: "NoSourcePath",
        layout: { storage: [], types: {} },
        deployedBytecode: PROVEN,
      }),
    ).rejects.toThrow(/malformed contract/);
  });
});
