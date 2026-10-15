#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReleaseId } from './package-server.mjs';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_MEMBERS = 10000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const FIXED_FILES = Object.freeze([
  'server/scripts/still-server.mjs', 'server/package.json', 'server/package-lock.json',
  'deploy/systemd/still.service', 'deploy/caddy/Caddyfile', 'deploy/still.env.example', 'docs/SERVER_OPERATIONS.md',
]);
const FORBIDDEN_NAME = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.cache|\.expo|\.test-data[^/]*|\.vitest[^/]*|__tests__|tests?|private|secrets?|recordings?|credentials?|vault|state)(?:\/|$)|(?:^|\/)[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|key|pem|p12|pfx|test\.[^/]+|spec\.[^/]+)$/i;
const SAFE_PATH = /^[A-Za-z0-9._/@-]+$/;
const FONT_PATH = /^dist-web\/assets\/node_modules\/@expo\/vector-icons\/build\/vendor\/react-native-vector-icons\/Fonts\/Ionicons\.[a-f0-9]{32}\.ttf$/i;
const FONT_DIRS = new Set([
  'dist-web/assets/node_modules', 'dist-web/assets/node_modules/@expo', 'dist-web/assets/node_modules/@expo/vector-icons',
  'dist-web/assets/node_modules/@expo/vector-icons/build', 'dist-web/assets/node_modules/@expo/vector-icons/build/vendor',
  'dist-web/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons',
  'dist-web/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts',
]);
const STATIC_FILES = new Set(['dist-web/index.html', 'dist-web/sw.js', 'dist-web/manifest.webmanifest', 'dist-web/assets/still-icon.png']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function nulTerminated(buffer) {
  const end = buffer.indexOf(0);
  const value = buffer.subarray(0, end < 0 ? buffer.length : end);
  if (value.some((byte) => byte > 0x7e || byte < 0x20)) throw new Error('archive_control_character');
  return value.toString('ascii');
}
function octal(buffer) {
  const value = nulTerminated(buffer).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error('archive_unsupported_number');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error('archive_number_invalid');
  return parsed;
}
function assertSafePath(path) {
  const localPath = path.split('/').slice(1).join('/');
  if (!path || !SAFE_PATH.test(path) || path.startsWith('/') || path.includes('\\') || path.includes('//') ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || FORBIDDEN_NAME.test(path) || /[\x00-\x20\x7f]/.test(path) ||
      (/(?:^|\/)node_modules(?:\/|$)/i.test(path) && !FONT_PATH.test(path) && !FONT_PATH.test(localPath) && !FONT_DIRS.has(path) && !FONT_DIRS.has(localPath))) {
    throw new Error(`archive_path_rejected:${path}`);
  }
}

function parseUstar(buffer) {
  const entries = new Map();
  let offset = 0;
  let unpacked = 0;
  let sawEnd = false;
  let sawDotRoot = false;
  let memberCount = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > buffer.length || !buffer.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)) throw new Error('archive_end_marker_invalid');
      sawEnd = true;
      if (!buffer.subarray(offset + 1024).every((byte) => byte === 0)) throw new Error('archive_trailing_data');
      break;
    }
    const expectedChecksum = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expectedChecksum) throw new Error('archive_header_checksum_invalid');
    if (header.subarray(257, 263).toString('ascii') !== 'ustar\0') throw new Error('archive_format_unsupported');
    const name = nulTerminated(header.subarray(0, 100));
    const prefix = nulTerminated(header.subarray(345, 500));
    let path = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    if (type === 53 && path.endsWith('/')) path = path.slice(0, -1);
    if (path === '.' && (type === 53 || type === 0)) path = '';
    else if (path.startsWith('./')) path = path.slice(2);
    if (type !== 48 && type !== 0 && type !== 53) throw new Error('archive_entry_type_unsupported');
    if (path === '') {
      if (type !== 53) throw new Error('archive_root_entry_type_invalid');
      if (sawDotRoot) throw new Error('archive_duplicate_path:.');
      sawDotRoot = true;
      if (octal(header.subarray(100, 108)) !== 0o755) throw new Error('archive_mode_invalid:.');
      const size = octal(header.subarray(124, 136));
      if (size !== 0) throw new Error('archive_root_has_data');
      const bodyOffset = offset + 512;
      const bodyEnd = bodyOffset + size;
      const nextOffset = bodyOffset + Math.ceil(size / 512) * 512;
      if (bodyEnd > buffer.length || nextOffset > buffer.length) throw new Error('archive_truncated');
      offset = nextOffset;
      continue;
    }
    assertSafePath(path);
    memberCount += 1;
    if (memberCount > MAX_MEMBERS) throw new Error('archive_member_count_limit');
    if (entries.has(path)) throw new Error(`archive_duplicate_path:${path}`);
    const size = octal(header.subarray(124, 136));
    if (type === 53 && size !== 0) throw new Error('archive_directory_has_data');
    const mode = octal(header.subarray(100, 108));
    if (mode !== (type === 53 ? 0o755 : 0o644)) throw new Error(`archive_mode_invalid:${path}`);
    const bodyOffset = offset + 512;
    const bodyEnd = bodyOffset + size;
    const nextOffset = bodyOffset + Math.ceil(size / 512) * 512;
    if (bodyEnd > buffer.length || nextOffset > buffer.length) throw new Error('archive_truncated');
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error('archive_unpacked_size_limit');
    const body = buffer.subarray(bodyOffset, bodyEnd);
    if (type === 53) entries.set(path, { type: 'directory', mode, size: 0 });
    else entries.set(path, { type: 'file', mode, size, sha256: sha256(body), body });
    offset = nextOffset;
  }
  if (!sawEnd) throw new Error('archive_missing_end_marker');
  return entries;
}

function allowedMember(path, releaseId, type) {
  if (path === releaseId) return type === 'directory';
  const root = `${releaseId}/`;
  if (!path.startsWith(root)) return false;
  const local = path.slice(root.length);
  if (!local) return type === 'directory';
  if (type === 'file') {
    return local === 'release-manifest.json' || FIXED_FILES.includes(local) ||
      /^server\/dist\/.+\.m?js$/i.test(local) || STATIC_FILES.has(local) ||
      /^dist-web\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.m?js$/i.test(local) ||
      /^dist-web\/pwa-register-[a-f0-9]{16}\.js$/i.test(local) || FONT_PATH.test(local);
  }
  return local === 'deploy' || local === 'deploy/systemd' || local === 'deploy/caddy' || local === 'docs' ||
    local === 'server' || local === 'server/scripts' || local === 'server/dist' || local.startsWith('server/dist/') ||
    local === 'dist-web' || local.startsWith('dist-web/');
}

function validateServerImports(entries, releaseId) {
  const pending = ['server/scripts/still-server.mjs'];
  const visited = new Set();
  const importPattern = /(?:\bfrom\s*|\bimport(?:\s*\()?)\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    const entry = entries.get(`${releaseId}/${path}`);
    if (!entry || entry.type !== 'file' || !/^server\/(?:scripts\/still-server\.mjs|dist\/.+\.m?js)$/.test(path)) throw new Error(`server_import_missing_or_rejected:${path}`);
    visited.add(path);
    const content = entry.body.toString('utf8');
    for (const match of content.matchAll(importPattern)) {
      const sentinel = '/__still_release_root__';
      const resolved = posix.resolve(sentinel, posix.dirname(path), match[1]);
      if (!resolved.startsWith(`${sentinel}/`) || !/\.m?js$/i.test(resolved)) throw new Error(`server_import_path_rejected:${match[1]}`);
      const target = resolved.slice(sentinel.length + 1);
      pending.push(target);
    }
  }
  for (const required of ['server/dist/config.js', 'server/dist/http.js', 'server/dist/applicationHost.js', 'server/dist/applicationHost.node.mjs']) {
    if (!visited.has(required)) throw new Error(`required_runtime_module_missing:${required}`);
  }
  const packaged = [...entries].filter(([path, entry]) => entry.type === 'file' && path.startsWith(`${releaseId}/server/dist/`)).map(([path]) => path.slice(releaseId.length + 1));
  const reachable = [...visited].filter((path) => path.startsWith('server/dist/'));
  if (packaged.length !== reachable.length || packaged.some((path) => !visited.has(path))) throw new Error('server_runtime_graph_mismatch');
}

function validateWebReferences(entries, releaseId) {
  const get = (relativePath) => entries.get(`${releaseId}/${relativePath}`)?.body;
  const config = get('server/dist/config.js')?.toString('utf8');
  if (!config?.includes("'../../dist-web'") && !config?.includes('"../../dist-web"')) throw new Error('static_root_reference_missing');
  const index = get('dist-web/index.html')?.toString('utf8');
  const serviceWorker = get('dist-web/sw.js')?.toString('utf8');
  const webManifest = get('dist-web/manifest.webmanifest');
  if (!index || !serviceWorker || !webManifest) throw new Error('web_shell_entry_missing');
  const referenced = new Set(['/manifest.webmanifest', '/sw.js']);
  for (const match of index.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) referenced.add(match[1]);
  try {
    const parsed = JSON.parse(webManifest.toString('utf8'));
    for (const icon of parsed.icons ?? []) if (typeof icon.src === 'string' && icon.src.startsWith('/')) referenced.add(icon.src);
  } catch { throw new Error('web_manifest_invalid'); }
  const staticPaths = serviceWorker.match(/const STATIC_PATHS = new Set\((\[[^;]*\])\);/);
  if (!staticPaths) throw new Error('service_worker_static_reference_parse_failed');
  let paths;
  try { paths = JSON.parse(staticPaths[1]); } catch { throw new Error('service_worker_static_reference_invalid'); }
  for (const item of paths) if (typeof item === 'string' && item.startsWith('/')) referenced.add(item);
  for (const urlPath of referenced) {
    if (urlPath === '/') continue;
    const local = urlPath.slice(1);
    if (!entries.has(`${releaseId}/dist-web/${local}`) || entries.get(`${releaseId}/dist-web/${local}`).type !== 'file') {
      throw new Error(`web_reference_missing:${urlPath}`);
    }
  }
}

export async function verifyServerPackage(archivePath, expectedSha256) {
  const absolute = resolve(archivePath);
  const info = await stat(absolute);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ARCHIVE_BYTES) throw new Error('archive_size_invalid');
  const compressed = await readFile(absolute);
  const digest = sha256(compressed);
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256) || digest !== expectedSha256)) {
    throw new Error('archive_sha256_mismatch');
  }
  let tarBytes;
  try { tarBytes = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES + 1024 * 1024 }); }
  catch { throw new Error('archive_gzip_invalid_or_too_large'); }
  const entries = parseUstar(tarBytes);
  const roots = [...entries.keys()].map((path) => path.split('/')[0]);
  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length !== 1) throw new Error('archive_release_root_invalid');
  const releaseId = validateReleaseId(uniqueRoots[0]);
  for (const [path, entry] of entries) if (!allowedMember(path, releaseId, entry.type)) throw new Error(`archive_member_not_allowlisted:${path}`);
  const manifestEntry = entries.get(`${releaseId}/release-manifest.json`);
  if (!manifestEntry || manifestEntry.type !== 'file' || manifestEntry.size > MAX_MANIFEST_BYTES) throw new Error('release_manifest_missing_or_large');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.body.toString('utf8')); } catch { throw new Error('release_manifest_invalid'); }
  if (manifest?.schemaVersion !== 1 || manifest.releaseId !== releaseId || !Array.isArray(manifest.files) ||
      manifest.target?.runtime !== 'Node.js 24.x intended; Linux target runtime remains unverified') throw new Error('release_manifest_contract_invalid');
  const manifested = new Map();
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('release_manifest_file_invalid');
    assertSafePath(file.path);
    if (manifested.has(file.path)) throw new Error(`release_manifest_duplicate:${file.path}`);
    manifested.set(file.path, file);
  }
  for (const relativePath of FIXED_FILES) if (!manifested.has(relativePath)) throw new Error(`required_file_missing:${relativePath}`);
  for (const path of ['server/dist/config.js', 'server/dist/http.js', 'server/dist/applicationHost.js', 'server/dist/applicationHost.node.mjs', 'dist-web/index.html', 'dist-web/sw.js', 'dist-web/manifest.webmanifest']) {
    if (!manifested.has(path)) throw new Error(`required_artifact_missing:${path}`);
  }
  const actualFiles = new Set([...entries].filter(([path, entry]) => entry.type === 'file' && path !== `${releaseId}/release-manifest.json`).map(([path]) => path.slice(releaseId.length + 1)));
  if (actualFiles.size !== manifested.size) throw new Error('release_manifest_file_set_mismatch');
  for (const [path, file] of manifested) {
    const entry = entries.get(`${releaseId}/${path}`);
    if (!entry || entry.type !== 'file' || entry.size !== file.size || entry.sha256 !== file.sha256) throw new Error(`release_file_hash_mismatch:${path}`);
    actualFiles.delete(path);
  }
  if (actualFiles.size) throw new Error('release_manifest_unlisted_file');
  const expectedDirectories = new Set();
  for (const relativePath of manifested.keys()) {
    const parts = `${releaseId}/${relativePath}`.split('/');
    for (let index = 2; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const actualDirectories = new Set([...entries].filter(([, entry]) => entry.type === 'directory').map(([path]) => path));
  if (actualDirectories.has(releaseId)) expectedDirectories.add(releaseId);
  if (actualDirectories.size !== expectedDirectories.size || [...actualDirectories].some((path) => !expectedDirectories.has(path))) throw new Error('release_directory_set_mismatch');
  validateServerImports(entries, releaseId);
  validateWebReferences(entries, releaseId);
  return Object.freeze({ releaseId, sha256: digest, files: manifested.size, paths: Object.freeze([...manifested.keys()]) });
}

function parseArgs(args) {
  let archive;
  let expectedSha256;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--expected-sha256') {
      if (expectedSha256 !== undefined || !args[i + 1]) throw new Error('expected_sha256_invalid');
      expectedSha256 = args[++i];
    } else if (!args[i].startsWith('--') && archive === undefined) archive = args[i];
    else throw new Error(`unknown_argument:${args[i]}`);
  }
  if (!archive) throw new Error('usage: node scripts/verify-server-package.mjs <archive.tar.gz> [--expected-sha256 <hex>]');
  return { archive, expectedSha256 };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifyServerPackage(args.archive, args.expectedSha256);
    process.stdout.write(`Verified release ${result.releaseId}: ${result.files} files; SHA-256 ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`verify-server-package: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}
