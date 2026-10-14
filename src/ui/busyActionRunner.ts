/** Synchronous shared exclusion used by the workspace action runner. */
export async function runWithBusyLock<T>(lock: { current: boolean }, action: () => Promise<T>): Promise<T | undefined> {
  if (lock.current) return undefined;
  lock.current = true;
  try {
    return await action();
  } finally {
    lock.current = false;
  }
}
