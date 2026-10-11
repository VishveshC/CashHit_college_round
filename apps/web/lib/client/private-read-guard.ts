export type PrivateReadContext = {
  generation: number;
  jobId: string;
  wallet: string;
  session: string;
};

export function privateReadIsCurrent(captured: PrivateReadContext, current: PrivateReadContext | null): boolean {
  return current !== null &&
    captured.generation === current.generation &&
    captured.jobId === current.jobId &&
    captured.wallet.toLowerCase() === current.wallet.toLowerCase() &&
    captured.session === current.session;
}

export async function commitPrivateReadIfCurrent<T>(
  captured: PrivateReadContext,
  current: () => PrivateReadContext | null,
  read: () => Promise<T>,
  commit: (value: T) => void,
): Promise<boolean> {
  const value = await read();
  if (!privateReadIsCurrent(captured, current())) return false;
  commit(value);
  return true;
}
