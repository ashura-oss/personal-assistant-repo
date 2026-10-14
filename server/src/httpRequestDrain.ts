import type { Server } from 'node:http';

const acceptedRequests = new WeakMap<Server, Set<Promise<void>>>();

/** @internal Registers this server before it begins accepting requests. */
export function registerAcceptedHttpServer(server: Server): void {
  if (acceptedRequests.has(server)) throw new Error('http_server_already_registered');
  acceptedRequests.set(server, new Set());
}

/** @internal Records the complete accepted request handler, including awaited bodies and services. */
export function trackAcceptedHttpRequest(server: Server, request: Promise<void>): void {
  let active = acceptedRequests.get(server);
  if (!active) { active = new Set(); acceptedRequests.set(server, active); }
  active.add(request);
  void request.then(() => active?.delete(request), () => active?.delete(request));
}

/** @internal Waits until every request accepted by this exact server has settled. */
export async function drainAcceptedHttpRequests(server: Server): Promise<void> {
  const active = acceptedRequests.get(server);
  if (!active) throw new Error('http_server_not_owned');
  while (active.size > 0) await Promise.allSettled([...active]);
}
