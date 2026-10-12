/** Browser documents stay in IndexedDB as part of the local application snapshot. */
export async function writePrivateDocument(_path: string, _content: string): Promise<void> {
  // IndexedDB persistence is handled by the state store; browsers have no private file directory.
}
