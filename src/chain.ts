import {
  EIP1967BeaconNotFound,
  EIP1967ImplementationNotFound,
  getBeaconAddress,
  getImplementationAddress,
  getImplementationAddressFromBeacon,
  type EthereumProvider,
} from "@openzeppelin/upgrades-core";
import { createHash } from "node:crypto";
import { LayoutUnavailableError } from "./errors.js";

/** The one JSON-RPC method used; Hardhat's network provider and ethers' JsonRpcProvider both fit. */
export interface EthProvider {
  send(method: string, params: unknown[]): Promise<unknown>;
}

export interface ProxyState {
  implementation: string;
  /** Set for a beacon proxy; `implementation` is then the beacon's. */
  beacon?: string;
}

/**
 * Reads what a proxy runs right now: the ERC-1967 implementation slot, or the
 * beacon's implementation for a beacon proxy. Undefined when neither slot is
 * set, i.e. the address is not a proxy this tool understands.
 */
export async function readProxy(
  provider: EthProvider,
  address: string,
): Promise<ProxyState | undefined> {
  const oz = provider as unknown as EthereumProvider;
  try {
    return { implementation: (await getImplementationAddress(oz, address)).toLowerCase() };
  } catch (e) {
    if (!(e instanceof EIP1967ImplementationNotFound)) throw e;
  }
  let beacon: string;
  try {
    beacon = (await getBeaconAddress(oz, address)).toLowerCase();
  } catch (e) {
    if (e instanceof EIP1967BeaconNotFound) return undefined;
    throw e;
  }
  const implementation = (await getImplementationAddressFromBeacon(oz, beacon)).toLowerCase();
  return { implementation, beacon };
}

export async function readImplementation(provider: EthProvider, proxy: string): Promise<string> {
  const state = await readProxy(provider, proxy);
  if (state === undefined) {
    throw new LayoutUnavailableError(
      `${proxy} has no ERC-1967 implementation or beacon slot set on this chain.`,
    );
  }
  return state.implementation;
}

export async function readCode(provider: EthProvider, address: string): Promise<string> {
  const code = (await provider.send("eth_getCode", [address, "latest"])) as string;
  if (code === "0x" || code === "") {
    throw new LayoutUnavailableError(`No code at ${address} on this chain.`);
  }
  return code.toLowerCase();
}

export async function readChainId(provider: EthProvider): Promise<number> {
  return Number(BigInt((await provider.send("eth_chainId", [])) as string));
}

export function codeSha256(code: string): string {
  return createHash("sha256")
    .update(Buffer.from(code.replace(/^0x/, ""), "hex"))
    .digest("hex");
}
