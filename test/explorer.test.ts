import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchVerifiedSource,
  parseSourceCodeEntry,
  ETHERSCAN_V2_API_URL,
} from "../src/explorer.js";
import { LayoutUnavailableError } from "../src/errors.js";

const ADDRESS = "0x00000000000000000000000000000000000000bb";
const STANDARD = {
  language: "Solidity",
  sources: { "contracts/A.sol": { content: "contract A {}" } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
};

function entry(sourceCode: string, compiler = "v0.8.25+commit.b61c2a91") {
  return { SourceCode: sourceCode, ContractName: "A", CompilerVersion: compiler };
}

function okResponse(result: unknown) {
  return { ok: true, status: 200, json: async () => ({ status: "1", message: "OK", result }) };
}

function errorResponse(result: string) {
  return { ok: true, status: 200, json: async () => ({ status: "0", message: "NOTOK", result }) };
}

describe("parseSourceCodeEntry", () => {
  it("unwraps Etherscan's double-brace standard-json", () => {
    const parsed = parseSourceCodeEntry(entry(`{${JSON.stringify(STANDARD)}}`), ADDRESS);
    expect(parsed.input).toEqual(STANDARD);
    expect(parsed.solcLongVersion).toBe("0.8.25+commit.b61c2a91");
    expect(parsed.contractName).toBe("A");
  });

  it("accepts unwrapped standard-json from compatible explorers", () => {
    const parsed = parseSourceCodeEntry(entry(JSON.stringify(STANDARD)), ADDRESS);
    expect(parsed.input.settings).toEqual(STANDARD.settings);
  });

  it("reports an unverified contract as unavailable", () => {
    expect(() => parseSourceCodeEntry(entry(""), ADDRESS)).toThrow(LayoutUnavailableError);
  });

  it("rejects flattened source as unavailable", () => {
    expect(() =>
      parseSourceCodeEntry(entry("pragma solidity 0.8.25; contract A {}"), ADDRESS),
    ).toThrow(/flattened or multi-file/);
  });

  it("rejects multi-file (non-standard) json as unavailable", () => {
    const multi = JSON.stringify({ "A.sol": { content: "contract A {}" } });
    expect(() => parseSourceCodeEntry(entry(multi), ADDRESS)).toThrow(LayoutUnavailableError);
  });

  it("rejects Vyper", () => {
    expect(() =>
      parseSourceCodeEntry(entry(JSON.stringify(STANDARD), "vyper:0.3.10"), ADDRESS),
    ).toThrow(/only Solidity/);
  });
});

describe("fetchVerifiedSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unavailable without an API key, and makes no request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchVerifiedSource(1, ADDRESS, {}, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is unavailable with an empty API key, and makes no request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchVerifiedSource(1, ADDRESS, { apiKey: "" }, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries Etherscan v2 with the chain id by default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse([entry(`{${JSON.stringify(STANDARD)}}`)]));
    await fetchVerifiedSource(8453, ADDRESS, { apiKey: "KEY" }, fetchImpl);

    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(ETHERSCAN_V2_API_URL);
    expect(url.searchParams.get("chainid")).toBe("8453");
    expect(url.searchParams.get("action")).toBe("getsourcecode");
    expect(url.searchParams.get("address")).toBe(ADDRESS);
    expect(url.searchParams.get("apikey")).toBe("KEY");
  });

  it("uses a configured apiUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([entry(JSON.stringify(STANDARD))]));
    await fetchVerifiedSource(
      43111,
      ADDRESS,
      { apiKey: "KEY", apiUrl: "https://explorer.example/api" },
      fetchImpl,
    );
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/explorer\.example\/api\?/);
  });

  it("retries on rate limiting", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Max rate limit reached"))
      .mockResolvedValueOnce(okResponse([entry(JSON.stringify(STANDARD))]));

    const pending = fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ contractName: "A" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected key as a configuration error, not a missing baseline", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse("Invalid API Key"));
    const err = await fetchVerifiedSource(1, ADDRESS, { apiKey: "BAD" }, fetchImpl).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LayoutUnavailableError);
    expect((err as Error).message).toMatch(/Invalid API Key/);
  });

  it("retries HTTP 429", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce(okResponse([entry(JSON.stringify(STANDARD))]));

    const pending = fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ contractName: "A" });
  });

  it("treats outages as unavailable, so auto mode can fall back", async () => {
    const cases = [
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
      vi.fn().mockResolvedValue(errorResponse("Free API access is not supported for this chain")),
    ];
    for (const fetchImpl of cases) {
      await expect(fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl)).rejects.toThrow(
        LayoutUnavailableError,
      );
    }
  });

  it("is unavailable once rate-limit retries run out", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse("Max rate limit reached"));
    const pending = fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(LayoutUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("queries a keyless custom explorer without an apikey parameter", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([entry(JSON.stringify(STANDARD))]));
    await fetchVerifiedSource(1, ADDRESS, { apiUrl: "https://blockscout.example/api" }, fetchImpl);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.has("apikey")).toBe(false);
  });

  it("keeps the API key out of error messages", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await fetchVerifiedSource(1, ADDRESS, { apiKey: "SECRET123" }, fetchImpl).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("SECRET123");
  });
});

describe("explorer edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats Etherscan's rate-limit message, which mentions the API key, as rate limiting", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        errorResponse("Max rate limit reached, please use API Key for higher rate limit"),
      );
    const pending = fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(LayoutUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats a response that is not JSON as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
  });

  it("treats a null source entry as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([null]));
    await expect(fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl)).rejects.toThrow(
      LayoutUnavailableError,
    );
  });

  it.each(["v0./../../../../bin/echo", "v0.8.25", "v0.8.25+commit.b61c2a91/x"])(
    "refuses a compiler version %s that is not a solc version",
    (version) => {
      expect(() => parseSourceCodeEntry(entry(JSON.stringify(STANDARD), version), ADDRESS)).toThrow(
        /unrecognized compiler version/,
      );
    },
  );

  it("accepts a pre-release compiler version", () => {
    const pre = "v0.8.31-pre.1+commit.b59566f6";
    expect(parseSourceCodeEntry(entry(JSON.stringify(STANDARD), pre), ADDRESS)).toMatchObject({
      solcLongVersion: pre.slice(1),
    });
  });

  it("accepts a nightly compiler version", () => {
    const nightly = "v0.8.26-nightly.2024.5.1+commit.0123abcd";
    expect(parseSourceCodeEntry(entry(JSON.stringify(STANDARD), nightly), ADDRESS)).toMatchObject({
      solcLongVersion: nightly.slice(1),
    });
  });
});
