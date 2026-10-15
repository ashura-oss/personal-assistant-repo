import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
export const ICON_SOURCE = path.join(WORKSPACE_ROOT, 'assets', 'still-icon.png');
const EXPO_JS_PREFIX = '/_expo/static/js/';
const PROTECTED_RESOURCE_PATH = /(?:^|\/)(?:api|auth|oauth|callback|audio|uploads?|secrets?|recordings?|private|state)(?:\/|$)/i;
const PROTECTED_OUTPUT_NAMES = new Set(['.git', '.expo', '.github', 'node_modules', 'server', 'src', 'assets', 'tests', 'scripts', 'patches', 'modules', 'plugins', 'dist', 'docs', 'work', 'coverage']);

export function assertProductionExportEnvironment(env = process.env) {
  if (String(env.EXPO_PUBLIC_PREVIEW_SCENARIO ?? '').trim()) {
    throw new Error('PWA export is disabled while EXPO_PUBLIC_PREVIEW_SCENARIO is set.');
  }
}

export function resolveOutputDirectory(workspaceRoot, requested = 'dist-web') {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, requested);
  if (target === root || path.dirname(target) !== root) {
    throw new Error('PWA output must be a single directory directly inside the workspace.');
  }
  if (PROTECTED_OUTPUT_NAMES.has(path.basename(target).toLowerCase())) {
    throw new Error('PWA output cannot replace a protected workspace directory.');
  }
  return target;
}

function toWebPath(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return `/${relative}`;
}

function isHashedAssetName(filePath) {
  return /(?:^|[._-])[a-f\d]{8,}(?:[._-]|$)/i.test(path.basename(filePath));
}

function isAllowedExpoBundlePath(urlPath) {
  return urlPath.startsWith(EXPO_JS_PREFIX) && /^\/_expo\/static\/js\/.+\.m?js$/i.test(urlPath) && isHashedAssetName(urlPath) && !PROTECTED_RESOURCE_PATH.test(urlPath);
}

function pwaRegistrationAsset() {
  const source = 'if ("serviceWorker" in navigator) { window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}); }); }\n';
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return { source, path: `/pwa-register-${digest}.js` };
}

function ensureViewportFitCover(html) {
  const match = html.match(/<meta\b(?=[^>]*\bname=["']viewport["'])[^>]*>/i);
  if (!match) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`);
  const tag = match[0];
  const content = tag.match(/\bcontent=(["'])(.*?)\1/i);
  if (!content) {
    return html.replace(tag, tag.replace(/\s*\/?>$/, (suffix) => ` content="width=device-width, initial-scale=1, viewport-fit=cover"${suffix}`));
  }
  const directives = content[2].split(',').map((value) => value.trim()).filter((value) => value && !/^viewport-fit\s*=/i.test(value));
  directives.push('viewport-fit=cover');
  const replacement = tag.replace(content[0], `content=${content[1]}${directives.join(', ')}${content[1]}`);
  return html.replace(tag, replacement);
}

function isAllowedRegistrationPath(urlPath, registrationPath) {
  return Boolean(registrationPath && urlPath === registrationPath && /^\/pwa-register-[a-f\d]{16}\.js$/i.test(urlPath));
}

function assertAllowedStaticPath(urlPath, registrationPath) {
  if (PROTECTED_RESOURCE_PATH.test(urlPath)) throw new Error(`Protected URL cannot be added to the PWA cache: ${urlPath}`);
  if (['/','/manifest.webmanifest','/assets/still-icon.png'].includes(urlPath)) return;
  if (isAllowedExpoBundlePath(urlPath) || /^\/assets\/.+\.(?:woff2?|ttf|otf)$/i.test(urlPath) && isHashedAssetName(urlPath) || isAllowedRegistrationPath(urlPath, registrationPath)) return;
  throw new Error(`URL is outside the PWA static cache allowlist: ${urlPath}`);
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function localPathFromHtmlReference(reference) {
  if (!reference || /^(?:[a-z]+:|\/\/|data:|#)/i.test(reference)) {
    throw new Error(`Export HTML contains a non-local static reference: ${reference || '(empty)'}`);
  }
  const parsed = new URL(reference, 'https://still.invalid/');
  if (parsed.origin !== 'https://still.invalid' || parsed.search || parsed.hash) {
    throw new Error(`Export HTML contains a non-static reference: ${reference}`);
  }
  return decodeURIComponent(parsed.pathname);
}

export async function collectCacheableAssetPaths(outputDirectory, html, registrationPath) {
  const outputRoot = path.resolve(outputDirectory);
  const htmlReferences = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => localPathFromHtmlReference(match[1]));
  for (const urlPath of htmlReferences) {
    const diskPath = path.resolve(outputRoot, `.${urlPath}`);
    if (!diskPath.startsWith(`${outputRoot}${path.sep}`) && diskPath !== outputRoot) {
      throw new Error(`Export HTML references a path outside the export: ${urlPath}`);
    }
    if (!existsSync(diskPath)) throw new Error(`Export HTML references a missing local file: ${urlPath}`);
  }
  const jsReferences = htmlReferences.filter((urlPath) => /\.m?js$/i.test(urlPath));
  if (jsReferences.length === 0) throw new Error('Expo export HTML has no local JavaScript bundle.');

  const paths = new Set(['/','/manifest.webmanifest','/assets/still-icon.png']);
  for (const urlPath of jsReferences) {
    const diskPath = path.resolve(outputRoot, `.${urlPath}`);
    if (!diskPath.startsWith(`${outputRoot}${path.sep}`) || !existsSync(diskPath)) {
      throw new Error(`Export references a missing or unsafe local script: ${urlPath}`);
    }
    if (isAllowedRegistrationPath(urlPath, registrationPath)) {
      if (!isHashedAssetName(urlPath)) throw new Error(`PWA registration script must have a content-hashed filename: ${urlPath}`);
    } else if (!isAllowedExpoBundlePath(urlPath)) {
      throw new Error(`HTML JavaScript reference is outside the hashed Expo bundle allowlist: ${urlPath}`);
    }
    assertAllowedStaticPath(urlPath, registrationPath);
    paths.add(urlPath);
  }
  if (!jsReferences.some(isAllowedExpoBundlePath)) throw new Error('Expo export HTML has no script from the hashed Expo bundle directory.');

  for (const filePath of await walkFiles(outputRoot)) {
    const extension = path.extname(filePath).toLowerCase();
    const webPath = toWebPath(outputRoot, filePath);
    if (['.js','.mjs'].includes(extension) && isAllowedExpoBundlePath(webPath)) {
      paths.add(webPath);
    } else if (['.woff','.woff2','.ttf','.otf'].includes(extension) && webPath.startsWith('/assets/') && isHashedAssetName(filePath)) {
      paths.add(webPath);
    }
  }
  return [...paths].sort();
}

export function createManifest(iconDimensions) {
  if (iconDimensions.width !== iconDimensions.height || iconDimensions.width < 1) {
    throw new Error('The Still app icon must be a square PNG with readable dimensions.');
  }
  return `${JSON.stringify({
    id: '/',
    name: 'Still',
    short_name: 'Still',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#101113',
    theme_color: '#101113',
    icons: [{ src: '/assets/still-icon.png', sizes: `${iconDimensions.width}x${iconDimensions.height}`, type: 'image/png', purpose: 'any' }],
  }, null, 2)}\n`;
}

export function createServiceWorker(cacheName, staticPaths, registrationPath) {
  for (const urlPath of staticPaths) assertAllowedStaticPath(urlPath, registrationPath);
  const serializedPaths = JSON.stringify(staticPaths);
  return `/* Generated for Still's static offline shell. App data and provider traffic are never cached. */\n` +
`const CACHE_NAME = ${JSON.stringify(cacheName)};\nconst STATIC_PATHS = new Set(${serializedPaths});\n` +
`const SHELL_PATH = '/';\n` +
`function isProtectedPath(pathname) { return /^\\/(?:api|auth|oauth|callback)(?:\\/|$)/i.test(pathname); }\n` +
`self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...STATIC_PATHS]))); });\n` +
`self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('still-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))))); });\n` +
`self.addEventListener('push', (event) => { event.waitUntil(self.registration.showNotification('Reminder', { body: 'You have a reminder.', icon: '/assets/still-icon.png', data: { schemaVersion: 1, type: 'reminder' } })); });\n` +
`self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => { const sameOrigin = windows.find((client) => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } }); return sameOrigin ? sameOrigin.navigate('/').then((client) => client ? client.focus() : self.clients.openWindow('/')) : self.clients.openWindow('/'); })); });\n` +
`self.addEventListener('fetch', (event) => {\n` +
`  const request = event.request; if (request.method !== 'GET') return;\n` +
`  const url = new URL(request.url); if (url.origin !== self.location.origin || url.search || isProtectedPath(url.pathname)) return;\n` +
`  if (request.mode === 'navigate') {\n` +
`    if (url.pathname !== '/' && url.pathname !== '/app') return;\n` +
`    event.respondWith(fetch(request).catch(async () => { const cache = await caches.open(CACHE_NAME); return (await cache.match(SHELL_PATH)) || Response.error(); })); return;\n` +
`  }\n` +
`  if (!STATIC_PATHS.has(url.pathname) || url.pathname === SHELL_PATH) return;\n` +
`  event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(request).then((cached) => cached || fetch(request))));\n` +
`});\n`;
}

export function readPngDimensions(pngBytes) {
  const png = Buffer.from(pngBytes);
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Still app icon is not a valid PNG with an IHDR header.');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function finalizePwaExport(outputDirectory, iconSource = ICON_SOURCE) {
  const outputRoot = path.resolve(outputDirectory);
  const htmlPath = path.join(outputRoot, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const iconBytes = await readFile(iconSource);
  const dimensions = readPngDimensions(iconBytes);
  const iconPath = path.join(outputRoot, 'assets', 'still-icon.png');
  await mkdir(path.dirname(iconPath), { recursive: true });
  await copyFile(iconSource, iconPath);
  const manifest = createManifest(dimensions);
  const manifestPath = path.join(outputRoot, 'manifest.webmanifest');
  await writeFile(manifestPath, manifest, 'utf8');

  const registration = pwaRegistrationAsset();
  const registrationPath = path.join(outputRoot, registration.path.slice(1));
  await writeFile(registrationPath, registration.source, 'utf8');
  const metadata = [
    '<meta name="theme-color" content="#101113">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="/assets/still-icon.png">',
    `<script defer src="${registration.path}"></script>`,
  ].join('\n    ');
  if (!/<head\b[^>]*>/i.test(html) || !/<\/head>/i.test(html)) throw new Error('Expo HTML has no complete head element.');
  const updatedHtml = ensureViewportFitCover(html.replace(/<head\b([^>]*)>/i, (head) => `${head}\n    ${metadata}`));
  const paths = await collectCacheableAssetPaths(outputRoot, updatedHtml, registration.path);
  const hash = createHash('sha256');
  for (const webPath of paths) {
    hash.update(webPath);
    if (webPath === '/') hash.update(updatedHtml);
    else if (webPath === '/manifest.webmanifest') hash.update(manifest);
    else hash.update(await readFile(path.join(outputRoot, `.${webPath}`)));
  }
  const cacheName = `still-shell-${hash.digest('hex').slice(0, 16)}`;
  const worker = createServiceWorker(cacheName, paths, registration.path);
  await writeFile(path.join(outputRoot, 'sw.js'), worker, 'utf8');
  await writeFile(htmlPath, updatedHtml, 'utf8');
  return { cacheName, staticPaths: paths, manifest: JSON.parse(manifest), workerPath: path.join(outputRoot, 'sw.js') };
}

function runExpoExport(workspaceRoot, outputDirectory, env) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(workspaceRoot, 'node_modules', 'expo', 'bin', 'cli');
    const child = spawn(process.execPath, [cliPath, 'export', '--platform', 'web', '--output-dir', outputDirectory], {
      cwd: workspaceRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Expo web export failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
    });
  });
}

export async function exportPwa({ workspaceRoot = WORKSPACE_ROOT, outputDirectory = 'dist-web', env = process.env } = {}) {
  assertProductionExportEnvironment(env);
  const target = resolveOutputDirectory(workspaceRoot, outputDirectory);
  const canonicalRoot = await realpath(workspaceRoot);
  const expectedTarget = path.join(canonicalRoot, path.basename(target));
  try {
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== expectedTarget) throw new Error('PWA output cannot be a symlink or alias to another workspace path.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await runExpoExport(workspaceRoot, target, env);
  return finalizePwaExport(target, path.join(workspaceRoot, 'assets', 'still-icon.png'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const requestedOutput = process.argv[2] ?? 'dist-web';
  exportPwa({ outputDirectory: requestedOutput }).then(({ cacheName, staticPaths }) => {
    console.log(`PWA shell prepared in dist export (cache ${cacheName}; ${staticPaths.length} static paths).`);
    console.log('Offline support is limited to the app shell and allowlisted hashed static assets.');
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
