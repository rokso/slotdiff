/**
 * In-memory JSON-RPC provider for the calls slotdiff makes:
 * eth_chainId, eth_getCode, eth_getStorageAt on the ERC-1967 implementation
 * and beacon slots, and eth_call of a beacon's implementation() (all reached
 * through oz-core's getImplementationAddressFromProxy).
 */
import { vi } from "vitest";

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const IMPLEMENTATION_SELECTOR = "0x5c60da1b"; // implementation()
const ZERO_WORD = "0x" + "0".repeat(64);

export interface MockChainState {
  chainId?: number;
  /** address → runtime code */
  code?: Record<string, string>;
  /** proxy address → implementation address (ERC-1967 implementation slot) */
  implementations?: Record<string, string>;
  /** beacon proxy address → beacon address (ERC-1967 beacon slot) */
  beacons?: Record<string, string>;
  /** beacon address → what its implementation() returns */
  beaconImplementations?: Record<string, string>;
}

export function makeMockChain(state: MockChainState = {}) {
  const code = lowerKeys(state.code ?? {});
  const implementations = lowerKeys(state.implementations ?? {});
  const beacons = lowerKeys(state.beacons ?? {});
  const beaconImplementations = lowerKeys(state.beaconImplementations ?? {});
  const send = vi.fn(async (method: string, params: unknown[] = []) => {
    switch (method) {
      case "eth_chainId":
        return "0x" + (state.chainId ?? 1).toString(16);
      case "eth_getCode":
        return code[String(params[0]).toLowerCase()] ?? "0x";
      case "eth_getStorageAt": {
        const [address, slot] = params as [string, string];
        const target =
          slot.toLowerCase() === IMPL_SLOT
            ? implementations[address.toLowerCase()]
            : slot.toLowerCase() === BEACON_SLOT
              ? beacons[address.toLowerCase()]
              : undefined;
        return target === undefined ? ZERO_WORD : word(target);
      }
      case "eth_call": {
        const [{ to, data }] = params as [{ to: string; data: string }];
        const impl = beaconImplementations[to.toLowerCase()];
        if (impl === undefined || !data.toLowerCase().startsWith(IMPLEMENTATION_SELECTOR)) {
          throw new Error("execution reverted");
        }
        return word(impl);
      }
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  });
  return { send };
}

/** A provider whose every call fails, as an unreachable RPC does. */
export function makeDeadChain() {
  return { send: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
}

function word(address: string): string {
  return "0x" + address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function lowerKeys(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
}
