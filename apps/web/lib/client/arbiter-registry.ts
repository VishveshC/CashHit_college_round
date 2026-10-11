import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { escrowAbi, publicClient, type PublicConfig } from "../chain.ts";
import { verifyDeployment } from "../chain-pins.ts";

export const MAX_ARBITERS = 128;

export type ArbiterRegistrySnapshot = {
  owner: Address;
  members: Address[];
  count: number;
  blockNumber: bigint;
};

export type ArbiterRegistryMethod = "addArbiter" | "removeArbiter";

type RegistryReadClient = {
  getBlockNumber(): Promise<bigint>;
  readContract(request: {
    address: Address;
    abi: typeof escrowAbi;
    functionName: "owner" | "arbiterCount" | "arbiterAt";
    args?: readonly bigint[];
    blockNumber: bigint;
  }): Promise<unknown>;
};

type RegistryReadDependencies = {
  client?: RegistryReadClient;
  verify?: (config: PublicConfig, client: RegistryReadClient) => Promise<void>;
};

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not a valid Ethereum address.`);
  }
  const address = getAddress(value);
  if (address.toLowerCase() === zeroAddress.toLowerCase()) {
    throw new Error(`${label} cannot be the zero address.`);
  }
  return address;
}

function parseCount(value: unknown): number {
  let count: bigint;
  if (typeof value === "bigint") {
    count = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    count = BigInt(value);
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    count = BigInt(value);
  } else {
    throw new Error("The on-chain arbiter count is invalid.");
  }

  if (count < 0n || count > BigInt(MAX_ARBITERS)) {
    throw new Error(`The on-chain arbiter count exceeds the contract limit of ${MAX_ARBITERS}.`);
  }
  return Number(count);
}

/**
 * Read the public roster from one pinned local deployment and one block.
 * Owner and membership are chain state; demo role labels never grant authority.
 */
export async function readArbiterRegistry(
  config: PublicConfig,
  dependencies: RegistryReadDependencies = {},
): Promise<ArbiterRegistrySnapshot> {
  const client = dependencies.client ?? (publicClient(config) as unknown as RegistryReadClient);
  const verify = dependencies.verify ?? (verifyDeployment as (config: PublicConfig, client: RegistryReadClient) => Promise<void>);
  await verify(config, client);

  const blockNumber = await client.getBlockNumber();
  const read = (functionName: "owner" | "arbiterCount" | "arbiterAt", args?: readonly bigint[]) =>
    client.readContract({ address: config.escrow, abi: escrowAbi, functionName, args, blockNumber });

  const owner = normalizeAddress(await read("owner"), "The escrow owner");
  const count = parseCount(await read("arbiterCount"));
  const rawMembers = await Promise.all(
    Array.from({ length: count }, (_, index) => read("arbiterAt", [BigInt(index)])),
  );

  const members = rawMembers.map((member, index) => normalizeAddress(member, `Arbiter ${index + 1}`));
  const seen = new Set<string>();
  for (const member of members) {
    const key = member.toLowerCase();
    if (seen.has(key)) throw new Error("The on-chain arbiter registry contains a duplicate member.");
    seen.add(key);
  }
  if (members.length !== count) throw new Error("The on-chain arbiter count changed while the roster was read.");

  return { owner, members, count, blockNumber };
}

export function isRegistryOwner(account: string | null | undefined, owner: string | null | undefined): boolean {
  return typeof account === "string" && typeof owner === "string" &&
    isAddress(account, { strict: false }) && isAddress(owner, { strict: false }) &&
    account.toLowerCase() === owner.toLowerCase();
}

/** Validate against the latest displayed snapshot; callers must re-read owner and membership before sending. */
export function validateArbiterRegistryChange(
  method: ArbiterRegistryMethod,
  inputAddress: string,
  account: string | null | undefined,
  snapshot: ArbiterRegistrySnapshot,
): Address {
  if (!isRegistryOwner(account, snapshot.owner)) {
    throw new Error("Only the current on-chain owner can change the arbiter registry.");
  }
  if (!Number.isSafeInteger(snapshot.count) || snapshot.count < 0 || snapshot.count > MAX_ARBITERS) {
    throw new Error("The arbiter registry snapshot is invalid or stale. Refresh before changing it.");
  }
  if (method === "addArbiter" && snapshot.count >= MAX_ARBITERS) {
    throw new Error(`The arbiter registry is full (${MAX_ARBITERS} members).`);
  }
  if (snapshot.count !== snapshot.members.length) {
    throw new Error("The arbiter registry snapshot is invalid or stale. Refresh before changing it.");
  }
  if (typeof inputAddress !== "string" || inputAddress !== inputAddress.trim() || !isAddress(inputAddress)) {
    throw new Error("Enter a valid Ethereum address. ENS names and surrounding whitespace are not accepted.");
  }

  const address = getAddress(inputAddress);
  if (address.toLowerCase() === zeroAddress.toLowerCase()) {
    throw new Error("The zero address cannot be added or removed.");
  }

  const isMember = snapshot.members.some((member) => member.toLowerCase() === address.toLowerCase());
  if (method === "addArbiter") {
    if (isMember) throw new Error("This address is already in the arbiter registry.");
  } else if (method === "removeArbiter") {
    if (!isMember) throw new Error("This address is not a current registry member.");
  } else {
    throw new Error("Unsupported arbiter registry action.");
  }

  return address;
}
