import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createServerPackage, tarExecutable, validateReleaseId } from '../scripts/package-server.mjs';
import { verifyServerPackage } from '../scripts/verify-server-package.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'still-package-fixture-'));
  const put = async (relative, content) => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  await put('server/scripts/still-server.mjs', "import '../dist/config.js';\nimport '../dist/http.js';\nimport '../dist/applicationHost.js';\nimport '../dist/applicationHost.node.mjs';\n");
  await put('server/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await put('server/package-lock.json', JSON.stringify({ name: 'fixture', lockfileVersion: 3 }));
  await put('server/dist/config.js', "export const STATIC_ROOT = '../../dist-web';\n");
  await put('server/dist/http.js', 'export {};\n');
  await put('server/dist/applicationHost.js', 'export {};\n');
  await put('server/dist/applicationHost.node.mjs', 'export {};\n');
  await put('server/dist/entry.js', 'export {};\n');
  await put('dist-web/index.html', '<script src="/_expo/static/js/web/index.js"></script><link href="/manifest.webmanifest">');
  await put('dist-web/sw.js', 'const STATIC_PATHS = new Set(["/","/_expo/static/js/web/index.js"]);');
  await put('dist-web/manifest.webmanifest', JSON.stringify({ name: 'Still', icons: [{ src: '/assets/still-icon.png' }] }));
  await put('dist-web/_expo/static/js/web/index.js', '/* fixture */');
  await put('dist-web/assets/still-icon.png', 'fixture-icon');
  await put('deploy/systemd/still.service', '[Service]\n');
  await put('deploy/caddy/Caddyfile', 'still.example.com { reverse_proxy 127.0.0.1:8787 }\n');
  await put('deploy/still.env.example', 'STILL_ORIGIN=https://still.example.com\n');
  await put('docs/SERVER_OPERATIONS.md', '# fixture\n');
  return { root, put };
}

function tarHeader(name, { type = '0', body = Buffer.alloc(0), mode = type === '5' ? 0o755 : 0o644 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const paddedBody = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(paddedBody);
  return Buffer.concat([header, paddedBody]);
}

function parseTarHeaders(archive) {
  const bytes = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const end = header.indexOf(0);
    const rawName = header.subarray(0, end < 0 || end > 100 ? 100 : end).toString('ascii');
    const rawPrefix = header.subarray(345, 500);
    const prefixEnd = rawPrefix.indexOf(0);
    const prefix = rawPrefix.subarray(0, prefixEnd < 0 ? rawPrefix.length : prefixEnd).toString('ascii');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const type = header[156];
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    entries.push({ name: name.endsWith('/') ? name.slice(0, -1) : name, type, mode: Number.parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(), 8) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function makeFixtureArchive(releaseId, files) {
  const directories = new Set();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  const chunks = [];
  for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    chunks.push(tarHeader(`${releaseId}/${directory}`, { type: '5' }));
  }
  for (const [path, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) chunks.push(tarHeader(`${releaseId}/${path}`, { body }));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

async function packageFixture(setup = async () => {}) {
  const { root, put } = await fixture();
  await setup({ root, put });
  // Keep publication separate from the source artifact tree. The packager must
  // stage its final archive on this destination filesystem before exclusive
  // publication, rather than assuming the OS temp directory shares a device.
  const outDir = await mkdtemp(join(tmpdir(), 'still-package-output-'));
  const result = await createServerPackage({ repositoryRoot: root, releaseId: 'fixture-1', outDir, runBuild: false });
  return { root, result, close: async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  } };
}

test('builds the closed release topology and verifies every manifest hash and web reference', async () => {
  const packaged = await packageFixture();
  try {
    const hash = (await readFile(packaged.result.checksumPath, 'ascii')).split(/\s+/)[0];
    const verified = await verifyServerPackage(packaged.result.archivePath, hash);
    await import(pathToFileURL(join(packaged.root, 'server/scripts/still-server.mjs')).href);
    assert.equal(verified.releaseId, 'fixture-1');
    assert.ok(verified.files >= 14);
    assert.match(packaged.result.archivePath, /still-fixture-1\.tar\.gz$/);
    const members = parseTarHeaders(await readFile(packaged.result.archivePath));
    assert.equal(members.some((entry) => entry.name === '.' || entry.name === './'), false);
    assert.ok(members.some((entry) => entry.type === 53 && entry.mode === 0o755));
    assert.ok(members.some((entry) => entry.type === 48 && entry.mode === 0o644));
    assert.ok(members.every((entry) => entry.type === 53 ? entry.mode === 0o755 : entry.mode === 0o644));
  } finally { await packaged.close(); }
});

test('extracting the archive leaves the caller-owned destination parent intact', async () => {
  const packaged = await packageFixture();
  const destination = await mkdtemp(join(tmpdir(), 'still-package-extract-'));
  try {
    const sentinel = join(destination, 'parent-sentinel.txt');
    await writeFile(sentinel, 'keep-parent');
    const before = await stat(destination);
    const extraction = spawnSync(tarExecutable(), ['-xzf', packaged.result.archivePath, '-C', destination], { encoding: 'utf8', windowsHide: true });
    assert.equal(extraction.status, 0, extraction.stderr || extraction.error?.message);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep-parent');
    assert.equal(await readFile(join(destination, 'fixture-1/server/scripts/still-server.mjs'), 'utf8') !== '', true);
    if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, before.mode & 0o777);
  } finally {
    await packaged.close();
    await rm(destination, { recursive: true, force: true });
  }
});

test('rejects unsafe release IDs and symlinks while omitting source-map and declaration outputs', async (context) => {
  for (const id of ['../escape', '..', 'two..dots', '/root', 'a\\b']) assert.throws(() => validateReleaseId(id), /release_id_invalid/);
  const { root } = await fixture();
  try {
    await symlink(join(root, 'dist-web/assets'), join(root, 'dist-web/asset-link'), 'junction');
    await assert.rejects(createServerPackage({ repositoryRoot: root, releaseId: 'symlink-case', outDir: join(root, 'out'), runBuild: false }), /package_symlink_rejected/);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') context.skip('This Windows host does not permit creating a disposable junction.');
    else throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
  const { root: privateRoot } = await fixture();
  try {
    await writeFile(join(privateRoot, 'server/dist/private.js.map'), '{}');
    await writeFile(join(privateRoot, 'server/dist/private.d.ts'), 'export {};');
    const packageResult = await createServerPackage({ repositoryRoot: privateRoot, releaseId: 'metadata-case', outDir: join(privateRoot, 'out'), runBuild: false });
    try {
      const verified = await verifyServerPackage(packageResult.archivePath);
      assert.ok(verified.files > 0);
      assert.equal(verified.paths.includes('server/dist/private.js.map'), false);
      assert.equal(verified.paths.includes('server/dist/private.d.ts'), false);
    } finally { await rm(join(privateRoot, 'out'), { recursive: true, force: true }); }
  } finally { await rm(privateRoot, { recursive: true, force: true }); }
});

test('rejects an output directory nested in generated input trees', async () => {
  const { root } = await fixture();
  try {
    await assert.rejects(createServerPackage({ repositoryRoot: root, releaseId: 'recursive', outDir: join(root, 'dist-web/packages'), runBuild: false }), /release_output_inside_input_tree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('detects a mismatched trusted checksum before processing the archive', async () => {
  const packaged = await packageFixture();
  try { await assert.rejects(verifyServerPackage(packaged.result.archivePath, '0'.repeat(64)), /archive_sha256_mismatch/); }
  finally { await packaged.close(); }
});

test('packages only the exact generated Ionicons font through its required asset directories', async () => {
  const font = 'assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.0123456789abcdef0123456789abcdef.ttf';
  const packaged = await packageFixture(async ({ put }) => {
    await put(`dist-web/${font}`, 'fixture-font');
    await put('dist-web/sw.js', `const STATIC_PATHS = new Set(["/","/_expo/static/js/web/index.js","/${font}"]);`);
  });
  try {
    const verified = await verifyServerPackage(packaged.result.archivePath);
    assert.ok(verified.paths.includes(`dist-web/${font}`));
    assert.equal(verified.paths.some((path) => path.includes('/node_modules/') && !path.endsWith('.ttf')), false);
  } finally { await packaged.close(); }
});

test('rejects an entrypoint relative import that escapes the versioned release root', async () => {
  const packaged = await packageFixture();
  const temp = await mkdtemp(join(tmpdir(), 'still-package-import-traversal-'));
  try {
    const verified = await verifyServerPackage(packaged.result.archivePath);
    const files = new Map();
    for (const path of verified.paths) {
      let content = await readFile(join(packaged.root, path));
      if (path === 'server/scripts/still-server.mjs') content = Buffer.concat([Buffer.from("import '../../../server/dist/config.js';\n"), content]);
      files.set(path, content);
    }
    const manifest = {
      schemaVersion: 1,
      releaseId: verified.releaseId,
      target: { runtime: 'Node.js 24.x intended; Linux target runtime remains unverified' },
      files: [...files].map(([path, content]) => ({
        path,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      })),
    };
    files.set('release-manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`));
    const maliciousArchive = join(temp, 'import-traversal.tar.gz');
    await writeFile(maliciousArchive, makeFixtureArchive(verified.releaseId, files));
    await assert.rejects(verifyServerPackage(maliciousArchive), /server_import_path_rejected:\.\.\/\.\.\/\.\.\/server\/dist\/config\.js/);
  } finally {
    await packaged.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('rejects a missing required artifact and missing exported static reference', async () => {
  const missing = await fixture();
  try {
    await rm(join(missing.root, 'server/dist/http.js'));
    await assert.rejects(createServerPackage({ repositoryRoot: missing.root, releaseId: 'missing-runtime', outDir: join(missing.root, 'out'), runBuild: false }), /runtime_import_missing:server\/dist\/http\.js/);
  } finally { await rm(missing.root, { recursive: true, force: true }); }
  const stale = await fixture();
  try {
    await stale.put('dist-web/index.html', '<script src="/missing.js"></script>');
    await assert.rejects(createServerPackage({ repositoryRoot: stale.root, releaseId: 'missing-web', outDir: join(stale.root, 'out'), runBuild: false }), /pwa_asset_not_allowlisted:\/missing\.js/);
  } finally { await rm(stale.root, { recursive: true, force: true }); }
});

test('rejects traversal and link entries in an otherwise valid USTAR archive', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'still-malicious-tar-'));
  try {
    const dotRootAndDuplicate = Buffer.concat([
      tarHeader('./', { type: '5' }),
      tarHeader('release-a/server/package.json'),
      tarHeader('release-a/server/package.json'),
      Buffer.alloc(1024),
    ]);
    const duplicatePath = join(temp, 'dot-root-duplicate.tar.gz');
    await writeFile(duplicatePath, gzipSync(dotRootAndDuplicate));
    await assert.rejects(verifyServerPackage(duplicatePath), /archive_duplicate_path/);
    const traversal = Buffer.concat([tarHeader('release-a/../outside'), Buffer.alloc(1024)]);
    const traversalPath = join(temp, 'traversal.tar.gz');
    await writeFile(traversalPath, gzipSync(traversal));
    await assert.rejects(verifyServerPackage(traversalPath), /archive_path_rejected/);
    const link = Buffer.concat([tarHeader('release-a/server/dist/link', { type: '2' }), Buffer.alloc(1024)]);
    const linkPath = join(temp, 'link.tar.gz');
    await writeFile(linkPath, gzipSync(link));
    await assert.rejects(verifyServerPackage(linkPath), /archive_entry_type_unsupported/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
