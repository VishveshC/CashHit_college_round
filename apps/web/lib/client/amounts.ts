function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Token decimals must be an integer between 0 and 36.");
  }
}

export function parseTokenAmount(decimalText: string, decimals: number): bigint {
  assertDecimals(decimals);
  const value = decimalText.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Enter a positive decimal amount without signs, separators, or scientific notation.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  return raw;
}

export function formatTokenAmount(raw: bigint, decimals: number, symbol: string): string {
  assertDecimals(decimals);
  if (raw < 0n) throw new Error("Token amount cannot be negative.");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const remainder = raw % scale;
  const wholeText = whole.toLocaleString("en-US");
  if (decimals === 0 || remainder === 0n) return `${wholeText} ${symbol}`;
  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${wholeText}.${fraction} ${symbol}`;
}
