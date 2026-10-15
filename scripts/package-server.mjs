#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, lstat, link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { exportPwa } from './export-pwa.mjs';
import { verifyServerPackage } from './verify-server-package.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const MAX_RELEASE_ID_LENGTH = 64;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const FIXED_FILES = Object.freeze([
  'server/package.json',
  'server/package-lock.json',
  'deploy/systemd/still.service',
  'deploy/caddy/Caddyfile',
  'deploy/still.env.example',
  'docs/SERVER_OPERATIONS.md',
]);
const FORBIDDEN_NAME = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.cache|\.expo|\.test-data[^/]*|\.vitest[^/]*|__tests__|tests?|private|secrets?|recordings?|credentials?|vault|state)(?:\/|$)|(?:^|\/)[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|key|pem|p12|pfx|test\.[^/]+|spec\.[^/]+)$/i;
const SAFE_PATH = /^[A-Za-z0-9._/@-]+$/;
const EXPO_BUNDLE_PATH = /^\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.m?js$/;
const EXPO_ICON_FONT_PATH = /^\/assets\/node_modules\/@expo\/vector-icons\/build\/vendor\/react-native-vector-icons\/Fonts\/Ionicons\.[a-f0-9]{32}\.ttf$/i;
const FONT_DIRS = new Set([
  'dist-web/assets/node_modules', 'dist-web/assets/node_modules/@expo', 'dist-web/assets/node_modules/@expo/vector-icons',
  'dist-web/assets/node_modules/@expo/vector-icons/build', 'dist-web/assets/node_modules/@expo/vector-icons/build/vendor',
  'dist-web/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons',
  'dist-web/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts',
]);

export function validateReleaseId(value) {
  if (typeof value !== 'string' || value.length > MAX_RELEASE_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..' || value.includes('..')) {
    throw new Error('release_id_invalid');
  }
  return value;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function normalizeUstarModes(compressedArchive) {
  let tarBytes;
  try { tarBytes = gunzipSync(compressedArchive, { maxOutputLength: 512 * 1024 * 1024 + 1024 * 1024 }); }
  catch { throw new Error('package_tar_gzip_invalid_or_too_large'); }
  const normalized = [];
  let offset = 0;
  let sawEnd = false;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tarBytes.length || !tarBytes.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)) throw new Error('package_tar_end_marker_invalid');
      normalized.push(tarBytes.subarray(offset));
      sawEnd = true;
      break;
    }
    if (header.subarray(257, 263).toString('ascii') !== 'ustar\0') throw new Error('package_tar_format_unsupported');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error('package_tar_size_invalid');
    const size = Number.parseInt(sizeField, 8);
    const bodyOffset = offset + 512;
    const bodyEnd = bodyOffset + size;
    const nextOffset = bodyOffset + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || bodyEnd > tarBytes.length || nextOffset > tarBytes.length) throw new Error('package_tar_truncated');
    const type = header[156];
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('ascii').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    if ((path === '.' || path === './') && type === 53 && size === 0) {
      offset = nextOffset;
      continue;
    }
    const mode = type === 53 ? 0o755 : type === 48 || type === 0 ? 0o644 : undefined;
    if (mode === undefined) throw new Error('package_tar_entry_type_unsupported');
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.fill(32, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    normalized.push(tarBytes.subarray(offset, nextOffset));
    offset = nextOffset;
  }
  if (!sawEnd) throw new Error('package_tar_end_marker_missing');
  return gzipSync(Buffer.concat(normalized), { level: 9 });
}

async function rejectSymlinkPath(path, finalMustBeDirectory = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let missing = false;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    if (missing) continue;
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') { missing = true; return undefined; }
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory()) ||
        (index === segments.length - 1 && finalMustBeDirectory && !info.isDirectory())) throw new Error(`package_path_ancestor_unsafe:${path}`);
  }
}

function assertSafeRelativePath(path, { allowPwaFont = false } = {}) {
  if (typeof path !== 'string' || !path || !SAFE_PATH.test(path) || path.startsWith('/') || path.includes('\\') ||
      path.split('/').some((segment) => !segment || segment === '.' || segment === '..') || /[\x00-\x20\x7f]/.test(path) ||
      FORBIDDEN_NAME.test(path) || (/(?:^|\/)node_modules(?:\/|$)/i.test(path) && !(allowPwaFont && (FONT_DIRS.has(path) || /^dist-web\/assets\/node_modules\/@expo\/vector-icons\/build\/vendor\/react-native-vector-icons\/Fonts\/Ionicons\.[a-f0-9]{32}\.ttf$/i.test(path)))) ||
      path.split('/').some((segment) => segment.startsWith('.') && segment !== '..')) throw new Error(`package_path_rejected:${String(path)}`);
}

async function scanSafeTree(sourceRoot, relativeRoot, allowedFiles, { omitBuildMetadata = false } = {}) {
  const source = await safeSourcePath(sourceRoot, relativeRoot, true);
  async function visit(current, relativePath) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const childRelative = `${relativePath}/${entry.name}`;
      const isMapOrDeclaration = /\.(?:map|d\.ts)$/i.test(childRelative);
      assertSafeRelativePath(childRelative, { allowPwaFont: FONT_DIRS.has(childRelative) || allowedFiles.has(childRelative) });
      const from = join(current, entry.name);
      const stat = await lstat(from);
      if (stat.isSymbolicLink()) throw new Error(`package_symlink_rejected:${childRelative}`);
      if (isMapOrDeclaration && omitBuildMetadata) continue;
      if (stat.isDirectory()) {
        if (relativeRoot === 'server/dist' && !childRelative.startsWith('server/dist/')) throw new Error(`package_dist_path_rejected:${childRelative}`);
        await visit(from, childRelative);
      } else if (stat.isFile()) {
        if (relativeRoot === 'server/dist') {
          if (!/\.m?js$/i.test(childRelative) && !/\.(?:map|d\.ts)$/i.test(childRelative)) throw new Error(`package_dist_file_rejected:${childRelative}`);
        } else if (relativeRoot === 'dist-web') {
          if (childRelative === 'dist-web/metadata.json') continue;
          if (!allowedFiles.has(childRelative) && !/\.map$/i.test(childRelative)) throw new Error(`package_web_extra_rejected:${childRelative}`);
        }
      } else {
        throw new Error(`package_entry_type_rejected:${childRelative}`);
      }
    }
  }
  await visit(source, relativeRoot);
}

async function safeSourcePath(sourceRoot, relativePath, expectDirectory) {
  let current = resolve(sourceRoot);
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory()) ||
        (index === segments.length - 1 && (expectDirectory ? !info.isDirectory() : !info.isFile()))) {
      throw new Error(`package_source_path_unsafe:${relativePath}`);
    }
  }
  return current;
}

async function addFile(from, stagingRoot, relativePath, manifestFiles) {
  assertSafeRelativePath(relativePath, { allowPwaFont: /^dist-web\/assets\/node_modules\/@expo\/vector-icons\/build\/vendor\/react-native-vector-icons\/Fonts\/Ionicons\.[a-f0-9]{32}\.ttf$/i.test(relativePath) });
  const bytes = await readFile(from);
  const destination = join(stagingRoot, ...relativePath.split('/'));
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(from, destination);
  manifestFiles.push(Object.freeze({ path: relativePath, size: bytes.length, sha256: sha256(bytes) }));
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: options.stdio ?? 'inherit', shell: false });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : rejectPromise(new Error(`command_failed:${command}:${code ?? signal}`)));
  });
}

export function tarExecutable(platform = process.platform) {
  return platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
}

async function packageSource(sourceRoot, stagingRoot, manifestFiles) {
  for (const relativePath of FIXED_FILES) {
    assertSafeRelativePath(relativePath);
    const source = await safeSourcePath(sourceRoot, relativePath, false);
    await addFile(source, stagingRoot, relativePath, manifestFiles);
  }
  const runtimeFiles = await collectServerRuntimeFiles(sourceRoot);
  const pwaFiles = await collectPwaFiles(sourceRoot);
  await scanSafeTree(sourceRoot, 'server/dist', new Set(runtimeFiles), { omitBuildMetadata: true });
  await scanSafeTree(sourceRoot, 'dist-web', pwaFiles, { omitBuildMetadata: true });
  for (const relativePath of [...runtimeFiles, ...pwaFiles].sort((a, b) => a.localeCompare(b, 'en'))) {
    const source = await safeSourcePath(sourceRoot, relativePath, false);
    await addFile(source, stagingRoot, relativePath, manifestFiles);
  }
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  const importPattern = /(?:\bfrom\s*|\bimport(?:\s*\()?)\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) specifiers.push(match[1]);
  return specifiers;
}

async function collectServerRuntimeFiles(root) {
  const entry = 'server/scripts/still-server.mjs';
  const pending = [entry];
  const visited = new Set();
  while (pending.length) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    if (!/^server\/(?:scripts\/still-server\.mjs|dist\/.+\.m?js)$/.test(relativePath)) throw new Error(`runtime_import_outside_allowlist:${relativePath}`);
    const sourcePath = await safeSourcePath(root, relativePath, false);
    const content = await readFile(sourcePath, 'utf8');
    visited.add(relativePath);
    for (const specifier of relativeImportSpecifiers(content)) {
      const target = resolve(dirname(sourcePath), specifier);
      const targetRelative = relative(root, target).split(sep).join('/');
      if (targetRelative.startsWith('../') || targetRelative.startsWith('/') || !/\.m?js$/i.test(targetRelative)) throw new Error(`runtime_import_rejected:${specifier}`);
      try { await safeSourcePath(root, targetRelative, false); }
      catch { throw new Error(`runtime_import_missing:${targetRelative}`); }
      pending.push(targetRelative);
    }
  }
  for (const required of ['server/dist/config.js', 'server/dist/http.js', 'server/dist/applicationHost.js', 'server/dist/applicationHost.node.mjs']) {
    if (!visited.has(required)) throw new Error(`required_runtime_module_unreachable:${required}`);
  }
  return [...visited];
}

function parseStaticPaths(source) {
  const match = source.match(/const STATIC_PATHS = new Set\((\[[^;]*\])\);/);
  if (!match) throw new Error('pwa_static_paths_invalid');
  let paths;
  try { paths = JSON.parse(match[1]); } catch { throw new Error('pwa_static_paths_invalid'); }
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string') || new Set(paths).size !== paths.length) throw new Error('pwa_static_paths_invalid');
  return paths;
}

async function collectPwaFiles(root) {
  const webRoot = await safeSourcePath(root, 'dist-web', true);
  const index = await readFile(join(webRoot, 'index.html'), 'utf8');
  const worker = await readFile(join(webRoot, 'sw.js'), 'utf8');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(webRoot, 'manifest.webmanifest'), 'utf8')); } catch { throw new Error('pwa_manifest_invalid'); }
  const urls = new Set(['/', '/sw.js', '/manifest.webmanifest']);
  for (const match of index.matchAll(/(?:src|href)=["'](\/[^"'?#]+)["']/g)) urls.add(match[1]);
  for (const icon of manifest.icons ?? []) if (typeof icon?.src === 'string') urls.add(icon.src);
  for (const path of parseStaticPaths(worker)) urls.add(path);
  if (!urls.has('/')) throw new Error('pwa_shell_reference_missing');
  const files = new Set();
  for (const url of urls) {
    if (url === '/') { files.add('dist-web/index.html'); continue; }
    if (!url.startsWith('/') || url.includes('\\') || /[?#\x00-\x20\x7f]/.test(url)) throw new Error(`pwa_reference_rejected:${url}`);
    const decoded = decodeURIComponent(url.slice(1));
    const isKnown = ['sw.js', 'manifest.webmanifest', 'assets/still-icon.png'].includes(decoded) ||
      /^pwa-register-[a-f0-9]{16}\.js$/i.test(decoded) ||
      EXPO_BUNDLE_PATH.test(url) || EXPO_ICON_FONT_PATH.test(url);
    if (!isKnown) throw new Error(`pwa_asset_not_allowlisted:${url}`);
    if (decoded.includes('..') || decoded.startsWith('/')) throw new Error(`pwa_reference_rejected:${url}`);
    await safeSourcePath(root, `dist-web/${decoded}`, false);
    files.add(`dist-web/${decoded}`);
  }
  return files;
}

/**
 * Build an immutable, closed-artifact package. `runBuild: false` is intentionally
 * an in-process test seam only; the CLI never exposes it.
 */
export async function createServerPackage({ repositoryRoot = REPOSITORY_ROOT, releaseId, outDir = join(repositoryRoot, 'release-packages'), runBuild = true, tarCommand = tarExecutable() }) {
  validateReleaseId(releaseId);
  const root = resolve(repositoryRoot);
  const output = resolve(outDir);
  await rejectSymlinkPath(root, true);
  await rejectSymlinkPath(output, true);
  const within = (base, candidate) => {
    const rel = relative(base, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };
  if (within(join(root, 'server', 'dist'), output) || within(join(root, 'dist-web'), output)) throw new Error('release_output_inside_input_tree');
  if (runBuild) {
    await exportPwa({ workspaceRoot: root, env: process.env });
    const serverRoot = join(root, 'server');
    const tscCli = await safeSourcePath(root, 'server/node_modules/typescript/bin/tsc', false);
    await run(process.execPath, [tscCli, '-p', 'tsconfig.json', '--sourceMap', 'false', '--declaration', 'false'], { cwd: serverRoot });
    await run(process.execPath, ['scripts/build-shared-controller.mjs'], { cwd: serverRoot });
  }

  const temporary = await mkdtemp(join(tmpdir(), 'still-package-'));
  const releaseRoot = join(temporary, releaseId);
  const manifestFiles = [];
  try {
    await mkdir(releaseRoot, { recursive: true, mode: 0o755 });
    await packageSource(root, releaseRoot, manifestFiles);
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const serverPackage = JSON.parse(await readFile(join(releaseRoot, 'server/package.json'), 'utf8'));
    const manifest = {
      schemaVersion: 1,
      releaseId,
      builtAt: new Date().toISOString(),
      build: { command: 'guarded PWA export + TypeScript release compile + shared runtime bundling', nodeVersion: process.version, platform: process.platform, architecture: process.arch },
      target: { runtime: 'Node.js 24.x intended; Linux target runtime remains unverified', packageManager: 'npm ci --omit=dev', serverPackageVersion: serverPackage.version },
      files: manifestFiles,
    };
    await writeFile(join(releaseRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });

    await mkdir(output, { recursive: true });
    const archiveName = `still-${releaseId}.tar.gz`;
    const archivePath = join(output, archiveName);
    const checksumPath = `${archivePath}.sha256`;
    if (await lstat(archivePath).then(() => true, () => false) || await lstat(checksumPath).then(() => true, () => false)) {
      throw new Error('release_output_already_exists');
    }
    // USTAR has a fixed, verifiable header format. Long path names fail closed.
    // bsdtar on Windows does not recurse a named directory operand; archiving
    // `.` from the isolated one-release staging directory is portable and keeps
    // the sole top-level member equal to the versioned release ID.
    const rawArchiveTemp = join(output, `.still-${releaseId}-${process.pid}-${Date.now()}.raw.tar.gz`);
    const archiveTemp = join(output, `.still-${releaseId}-${process.pid}-${Date.now()}.tmp.tar.gz`);
    const checksumTemp = `${archiveTemp}.sha256`;
    let linkedArchive = false;
    let linkedChecksum = false;
    try {
      await run(tarCommand, ['--format=ustar', '-czf', rawArchiveTemp, '-C', temporary, '.']);
      const rawArchiveInfo = await lstat(rawArchiveTemp);
      if (!rawArchiveInfo.isFile() || rawArchiveInfo.size <= 0 || rawArchiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error('package_archive_size_invalid');
      const normalizedArchive = normalizeUstarModes(await readFile(rawArchiveTemp));
      if (normalizedArchive.length <= 0 || normalizedArchive.length > MAX_ARCHIVE_BYTES) throw new Error('package_archive_size_invalid');
      await writeFile(archiveTemp, normalizedArchive, { flag: 'wx' });
      const archiveInfo = await lstat(archiveTemp);
      if (!archiveInfo.isFile() || archiveInfo.size <= 0 || archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error('package_archive_size_invalid');
      await verifyServerPackage(archiveTemp);
      const archiveBytes = await readFile(archiveTemp);
      const archiveHash = sha256(archiveBytes);
      await writeFile(checksumTemp, `${archiveHash}  ${archiveName}\n`, { encoding: 'ascii', mode: 0o644, flag: 'wx' });
      await link(archiveTemp, archivePath);
      linkedArchive = true;
      await link(checksumTemp, checksumPath);
      linkedChecksum = true;
      return Object.freeze({ archivePath, checksumPath, sha256: archiveHash, releaseId });
    } catch (error) {
      if (linkedChecksum) await unlink(checksumPath).catch(() => {});
      if (linkedArchive) await unlink(archivePath).catch(() => {});
      throw error;
    } finally {
      await unlink(archiveTemp).catch(() => {});
      await unlink(rawArchiveTemp).catch(() => {});
      await unlink(checksumTemp).catch(() => {});
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--release-id' && flag !== '--out-dir') throw new Error(`unknown_argument:${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
    const key = flag === '--release-id' ? 'releaseId' : 'outDir';
    if (Object.hasOwn(result, key)) throw new Error(`duplicate_argument:${flag}`);
    result[key] = value;
  }
  if (!result.releaseId) throw new Error('required_argument:--release-id');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await createServerPackage(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Created ${result.archivePath}\nSHA-256 ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`package-server: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}
