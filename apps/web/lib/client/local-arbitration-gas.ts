export function localArbitrationGasLimit(
  functionName: string,
  walletSource: string,
  chainId: number,
): bigint | undefined {
  if (functionName !== "advanceDispute" || walletSource !== "demo" || chainId !== 31337) return undefined;
  return 2_000_000n;
}
