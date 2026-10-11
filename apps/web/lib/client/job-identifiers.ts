const MAX_UINT256 = (1n << 256n) - 1n;

/** Parse one canonical decimal identifier in the contract's uint256 range. */
export function parseJobIdentifier(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT256 ? parsed : null;
  } catch {
    return null;
  }
}

/** Extract a valid ID from parsed JobCreated logs without treating 0n as absent. */
export function extractCreatedJobIdentifier(logs: unknown): bigint | null {
  if (!Array.isArray(logs)) return null;
  const event = logs.find((entry: any) => entry?.eventName === "JobCreated");
  const value = event?.args?.jobId;
  if (typeof value === "bigint") return value >= 0n && value <= MAX_UINT256 ? value : null;
  if (typeof value === "string") return parseJobIdentifier(value);
  return null;
}
