/** Desktop device integration must never veto a committed vault operation. */
export async function desktopVaultAction<T>(
  vault: () => Promise<unknown>,
  device: () => Promise<T>,
  report: (error: unknown) => void,
): Promise<T | undefined> {
  await vault();
  try {
    return await device();
  } catch (error) {
    report(error);
    return undefined;
  }
}
