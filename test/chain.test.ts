import { describe, it, expect } from "vitest";
import { readProxy, type EthProvider } from "../src/chain.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";

describe("readProxy", () => {
  it("propagates an RPC error on the beacon slot instead of returning 'not a proxy'", async () => {
    const zero = "0x" + "00".repeat(32);
    let reads = 0;
    const provider = {
      send: async (method: string) => {
        if (method === "eth_getStorageAt") {
          // The implementation slot (and its fallback) read as empty; the beacon slot read fails.
          reads++;
          if (reads <= 2) return zero;
          throw new Error("rpc down");
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(readProxy(provider, PROXY)).rejects.toThrow(/rpc down/);
  });
});

describe("readProxy states", () => {
  const IMPL = "0x00000000000000000000000000000000000000bb";
  const BEACON = "0x00000000000000000000000000000000000000cc";

  it("reads a beacon proxy's implementation through its beacon", async () => {
    const provider = makeMockChain({
      beacons: { [PROXY]: BEACON },
      beaconImplementations: { [BEACON]: IMPL },
    });
    expect(await readProxy(provider, PROXY)).toEqual({ implementation: IMPL, beacon: BEACON });
  });

  it("is undefined for an address with neither slot set", async () => {
    expect(await readProxy(makeMockChain(), PROXY)).toBeUndefined();
  });
});

describe("EthProvider", () => {
  it("accepts the provider shapes of ethers v6 and Hardhat (checked by tsc)", () => {
    // ethers v6 JsonRpcProvider.send requires params; Hardhat's makes them optional.
    const ethers = { send: async (m: string, p: unknown[] | Record<string, unknown>) => [m, p] };
    const hardhat = { send: async (m: string, p?: unknown[]) => [m, p] };
    const providers: EthProvider[] = [ethers, hardhat];
    expect(providers).toHaveLength(2);
  });
});
