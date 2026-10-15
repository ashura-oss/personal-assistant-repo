import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertProductionExportEnvironment,
  collectCacheableAssetPaths,
  createManifest,
  createServiceWorker,
  finalizePwaExport,
  ICON_SOURCE,
  readPngDimensions,
  resolveOutputDirectory,
} from '../scripts/export-pwa.mjs';

const tempDirectories: string[] = [];

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'still-pwa-test-'));
  tempDirectories.push(root);
  await mkdir(path.join(root, '_expo', 'static', 'js', 'web'), { recursive: true });
  await mkdir(path.join(root, 'assets', 'fonts'), { recursive: true });
  await writeFile(path.join(root, '_expo', 'static', 'js', 'web', 'AppEntry-aabbccddeeff0011.js'), 'bundle();');
  await writeFile(path.join(root, '_expo', 'static', 'js', 'web', 'lazy-1122334455667788.js'), 'lazy();');
  await writeFile(path.join(root, 'assets', 'fonts', 'Ionicons-aabbccddeeff0011.ttf'), 'font');
  await writeFile(path.join(root, 'assets', 'not-hashed.png'), 'not cached');
  await writeFile(path.join(root, '_expo', 'static', 'js', 'web', 'audio-preview-aabbccddeeff0011.mp3'), 'audio');
  await writeFile(path.join(root, 'private-data-aabbccddeeff0011.js'), 'not a web bundle');
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><title>Still</title></head><body><script src="/_expo/static/js/web/AppEntry-aabbccddeeff0011.js" defer></script></body></html>');
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PWA export packaging', () => {
  it('rejects preview builds and output paths outside safe workspace children', () => {
    expect(() => assertProductionExportEnvironment({ EXPO_PUBLIC_PREVIEW_SCENARIO: 'openrouter-chat' })).toThrow(/preview/i);
    expect(() => resolveOutputDirectory('C:/workspace', '../outside')).toThrow(/directly inside/i);
    expect(() => resolveOutputDirectory('C:/workspace', 'server')).toThrow(/protected/i);
    expect(resolveOutputDirectory('C:/workspace', 'dist-web')).toBe(path.resolve('C:/workspace/dist-web'));
  });

  it('validates the source PNG and emits an origin-relative standalone portrait manifest', async () => {
    const icon = await readFile(ICON_SOURCE);
    const dimensions = readPngDimensions(icon);
    expect(dimensions.width).toBe(1024);
    expect(dimensions.height).toBe(1024);
    const manifest = JSON.parse(createManifest(dimensions));
    expect(manifest).toMatchObject({ display: 'standalone', orientation: 'portrait', start_url: '/', scope: '/', theme_color: '#101113' });
    expect(manifest.icons).toEqual([{ src: '/assets/still-icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' }]);
    expect(manifest.start_url).not.toMatch(/localhost|127\.0\.0\.1/i);
  });

  it('allowlists only the app shell, hashed local JS/fonts, manifest, and supplied icon', async () => {
    const root = await makeFixture();
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const paths = await collectCacheableAssetPaths(root, html);
    expect(paths).toContain('/');
    expect(paths).toContain('/manifest.webmanifest');
    expect(paths).toContain('/assets/still-icon.png');
    expect(paths).toContain('/_expo/static/js/web/AppEntry-aabbccddeeff0011.js');
    expect(paths).toContain('/_expo/static/js/web/lazy-1122334455667788.js');
    expect(paths).toContain('/assets/fonts/Ionicons-aabbccddeeff0011.ttf');
    expect(paths).not.toContain('/assets/not-hashed.png');
    expect(paths).not.toContain('/_expo/static/js/web/audio-preview-aabbccddeeff0011.mp3');
    expect(paths).not.toContain('/private-data-aabbccddeeff0011.js');
    expect(paths.some((item) => /(?:api|oauth|audio|upload|state)/i.test(item))).toBe(false);
  });

  it('rejects hashed HTML script references in API, auth, OAuth, callback, or other non-Expo paths', async () => {
    const root = await makeFixture();
    for (const route of ['api/report-deadbeef.js', 'auth/entry-deadbeef.js', 'oauth/entry-deadbeef.js', 'callback/entry-deadbeef.js', 'audio/preview-deadbeef.js']) {
      const diskPath = path.join(root, route);
      await mkdir(path.dirname(diskPath), { recursive: true });
      await writeFile(diskPath, 'not a bundle');
      const reference = `/${route}`;
      const html = `<html><head></head><body><script src="${reference}"></script></body></html>`;
      await expect(collectCacheableAssetPaths(root, html)).rejects.toThrow(/outside the hashed Expo bundle allowlist/i);
    }
    await expect(collectCacheableAssetPaths(root, '<html><head></head><body><script src="https://example.invalid/app-deadbeef.js"></script></body></html>')).rejects.toThrow(/non-local/i);
    expect(() => createServiceWorker('still-shell-0123456789abcdef', ['/','/api/report-deadbeef.js'])).toThrow(/Protected URL/i);
    expect(() => createServiceWorker('still-shell-0123456789abcdef', ['/','/other-file-deadbeef.js'])).toThrow(/outside the PWA static cache allowlist/i);
  });

  it('intercepts only allowlisted same-origin GETs and reads static responses from the current cache', async () => {
    const cacheName = 'still-shell-0123456789abcdef';
    const staticPaths = ['/', '/manifest.webmanifest', '/assets/still-icon.png', '/_expo/static/js/web/AppEntry-aabbccddeeff0011.js'];
    const worker = createServiceWorker(cacheName, staticPaths);
    expect(worker).not.toMatch(/skipWaiting|clients\.claim/);
    const listeners = new Map<string, (event: { request?: { method: string; url: string; mode: string }; respondWith?: (value: Promise<unknown> | unknown) => void; waitUntil?: (value: Promise<unknown>) => void }) => void>();
    const opened: string[] = [];
    const precached: string[][] = [];
    const matched: string[] = [];
    let globalCacheMatchCalls = 0;
    let networkCalls = 0;
    const currentCache = {
      addAll: async (paths: string[]) => { precached.push(paths); },
      match: async (request: { url: string }) => { matched.push(request.url); return undefined; },
    };
    const cachesMock = {
      open: async (name: string) => { opened.push(name); return currentCache; },
      keys: async () => [],
      delete: async () => true,
      match: async () => { globalCacheMatchCalls += 1; return 'old-cache-response'; },
    };
    const serviceWorkerScope = {
      location: { origin: 'https://still.example' },
      addEventListener: (type: string, listener: (event: { request?: { method: string; url: string; mode: string }; respondWith?: (value: Promise<unknown> | unknown) => void; waitUntil?: (value: Promise<unknown>) => void }) => void) => listeners.set(type, listener),
    };
    runInNewContext(worker, {
      self: serviceWorkerScope,
      caches: cachesMock,
      URL,
      Promise,
      Response: { error: () => 'offline-error' },
      fetch: async () => { networkCalls += 1; return 'network-response'; },
    });

    let installPromise: Promise<unknown> | undefined;
    listeners.get('install')?.({ waitUntil: (value) => { installPromise = value; } });
    await installPromise;
    expect(precached).toEqual([staticPaths]);
    expect(opened).toContain(cacheName);
    opened.length = 0;

    const makeEvent = (method: string, url: string, mode = 'cors') => {
      let response: Promise<unknown> | unknown;
      listeners.get('fetch')?.({ request: { method, url, mode }, respondWith: (value) => { response = value; } });
      return { wasIntercepted: response !== undefined, response };
    };
    const staticRequest = makeEvent('GET', 'https://still.example/_expo/static/js/web/AppEntry-aabbccddeeff0011.js');
    expect(staticRequest.wasIntercepted).toBe(true);
    await expect(staticRequest.response).resolves.toBe('network-response');
    expect(opened).toEqual([cacheName]);
    expect(matched).toEqual(['https://still.example/_expo/static/js/web/AppEntry-aabbccddeeff0011.js']);
    expect(globalCacheMatchCalls).toBe(0);

    const before = networkCalls;
    for (const [method, url] of [
      ['GET', 'https://still.example/api/report-deadbeef.js'],
      ['GET', 'https://still.example/auth/callback'],
      ['GET', 'https://still.example/oauth/return?code=private'],
      ['GET', 'https://still.example/_expo/static/js/web/AppEntry-aabbccddeeff0011.js?v=2'],
      ['GET', 'https://external.invalid/_expo/static/js/web/AppEntry-aabbccddeeff0011.js'],
      ['POST', 'https://still.example/_expo/static/js/web/AppEntry-aabbccddeeff0011.js'],
    ]) {
      expect(makeEvent(method, url).wasIntercepted).toBe(false);
    }
    expect(networkCalls).toBe(before);
  });

  it('shows only fixed generic reminders and opens the same-origin inbox on notification click', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const shown: unknown[] = [];
    const opened: string[] = [];
    let focused = 0;
    let navigated = '';
    const existingClient = { url: 'https://still.example/private/path', navigate: async (url: string) => { navigated = url; return existingClient; },
      focus: async () => { focused += 1; } };
    const serviceWorkerScope = {
      location: { origin: 'https://still.example' },
      registration: { showNotification: async (...args: unknown[]) => { shown.push(args); } },
      clients: { matchAll: async () => [existingClient], openWindow: async (url: string) => { opened.push(url); } },
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    };
    runInNewContext(createServiceWorker('still-shell-0123456789abcdef', ['/']), { self: serviceWorkerScope, URL, Promise });
    let pushWork: Promise<unknown> | undefined;
    listeners.get('push')?.({ data: { json: () => { throw new Error('payload must not be read'); } }, waitUntil: (work: Promise<unknown>) => { pushWork = work; } });
    await pushWork;
    expect(shown).toEqual([['Reminder', { body: 'You have a reminder.', icon: '/assets/still-icon.png', data: { schemaVersion: 1, type: 'reminder' } }]]);

    let clickWork: Promise<unknown> | undefined;
    let closed = false;
    listeners.get('notificationclick')?.({ notification: { close: () => { closed = true; }, data: { url: 'https://attacker.invalid/' } },
      waitUntil: (work: Promise<unknown>) => { clickWork = work; } });
    await clickWork;
    expect(closed).toBe(true);
    expect(navigated).toBe('/');
    expect(focused).toBe(1);
    expect(opened).toEqual([]);
  });

  it('opens only the fixed same-origin inbox when no same-origin client exists', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const opened: string[] = [];
    const serviceWorkerScope = { location: { origin: 'https://still.example' },
      clients: { matchAll: async () => [{ url: 'https://attacker.invalid/', focus: async () => undefined }], openWindow: async (url: string) => { opened.push(url); } },
      registration: { showNotification: async () => undefined }, addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener) };
    runInNewContext(createServiceWorker('still-shell-0123456789abcdef', ['/']), { self: serviceWorkerScope, URL, Promise });
    let clickWork: Promise<unknown> | undefined;
    listeners.get('notificationclick')?.({ notification: { close: () => undefined, data: { url: '/evil' } }, waitUntil: (work: Promise<unknown>) => { clickWork = work; } });
    await clickWork;
    expect(opened).toEqual(['/']);
  });

  it('postprocesses an actual export-shaped directory with the existing icon and hashed local registration', async () => {
    const root = await makeFixture();
    const result = await finalizePwaExport(root);
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.webmanifest'), 'utf8'));
    const worker = await readFile(path.join(root, 'sw.js'), 'utf8');
    const copiedIcon = await readFile(path.join(root, 'assets', 'still-icon.png'));
    expect(html).toMatch(/<meta\s+name="viewport"\s+content="[^"]*viewport-fit=cover[^"]*">/i);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/still-icon.png">');
    const registration = html.match(/<script defer src="(\/pwa-register-[a-f\d]{16}\.js)"><\/script>/i)?.[1];
    expect(registration).toBeTruthy();
    expect(html).not.toContain('navigator.serviceWorker.register');
    expect(result.staticPaths).toContain(registration);
    expect(await readFile(path.join(root, registration!.slice(1)), 'utf8')).toContain('navigator.serviceWorker.register("/sw.js"');
    expect(manifest.icons[0].sizes).toBe('1024x1024');
    expect(readPngDimensions(copiedIcon)).toEqual({ width: 1024, height: 1024 });
    expect(result.cacheName).toMatch(/^still-shell-[a-f0-9]{16}$/);
    expect(worker).toContain(result.cacheName);
    expect(result.staticPaths).not.toContain('/assets/not-hashed.png');
  });
});
