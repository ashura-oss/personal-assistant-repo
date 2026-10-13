const openConnections = new Map<string, Set<IDBDatabase>>();
const databaseGenerations = new Map<string, number>();

export function browserDatabaseGeneration(name: string): number {
  return databaseGenerations.get(name) ?? 0;
}

function bumpGeneration(name: string): void {
  databaseGenerations.set(name, browserDatabaseGeneration(name) + 1);
}

export function registerBrowserDatabase(name: string, database: IDBDatabase): () => void {
  bumpGeneration(name);
  let connections = openConnections.get(name);
  if (!connections) { connections = new Set(); openConnections.set(name, connections); }
  connections.add(database);
  let closed = false;
  const unregister = () => {
    if (closed) return;
    closed = true;
    connections?.delete(database);
    if (connections?.size === 0) openConnections.delete(name);
  };
  database.onversionchange = () => { database.close(); unregister(); };
  return unregister;
}

export function closeBrowserDatabaseConnections(name: string): void {
  const connections = openConnections.get(name);
  if (!connections) return;
  for (const database of [...connections]) {
    database.close();
    connections.delete(database);
  }
  openConnections.delete(name);
}

export function closeTrackedBrowserDatabase(name: string, database: IDBDatabase, unregister: () => void): void {
  try { database.close(); } finally { unregister(); }
}
