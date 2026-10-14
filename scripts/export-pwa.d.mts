export const WORKSPACE_ROOT: string;
export const ICON_SOURCE: string;
export function assertProductionExportEnvironment(env?: Record<string, string | undefined>): void;
export function resolveOutputDirectory(workspaceRoot: string, requested?: string): string;
export function collectCacheableAssetPaths(outputDirectory: string, html: string, registrationPath?: string): Promise<string[]>;
export function createManifest(iconDimensions: { width: number; height: number }): string;
export function createServiceWorker(cacheName: string, staticPaths: string[], registrationPath?: string): string;
export function readPngDimensions(pngBytes: Uint8Array): { width: number; height: number };
export function finalizePwaExport(outputDirectory: string, iconSource?: string): Promise<{
  cacheName: string;
  staticPaths: string[];
  manifest: Record<string, unknown>;
  workerPath: string;
}>;
export function exportPwa(options?: { workspaceRoot?: string; outputDirectory?: string; env?: Record<string, string | undefined> }): Promise<{
  cacheName: string;
  staticPaths: string[];
  manifest: Record<string, unknown>;
  workerPath: string;
}>;
