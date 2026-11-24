/** A lost POST response does not prove the write stopped. Only re-enable
 * editing after a settled POST, or after observing the requested company. */
export async function confirmCompanySwitch<
  T extends { company: { id: string } | null },
>(
  target: string,
  post: () => Promise<unknown>,
  readSession: () => Promise<T | null>,
): Promise<T & { company: { id: string } }> {
  let settled = false;
  try {
    await post();
    settled = true;
  } catch {
    /* Reconcile below. */
  }
  const session = await readSession();
  if (!session?.company || (!settled && session.company.id !== target)) {
    throw new Error("Active company is not confirmed");
  }
  return session as T & { company: { id: string } };
}
