import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const lock = JSON.parse(readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, {
    version?: string;
    resolved?: string;
    integrity?: string;
    optional?: boolean;
    os?: string[];
    cpu?: string[];
    libc?: string[];
    optionalDependencies?: Record<string, string>;
  }>;
};

const officialPlatforms: Record<string, { os: string; cpu: string; libc?: 'glibc' | 'musl' }> = {
  '@rolldown/binding-android-arm-eabi': { os: 'android', cpu: 'arm' },
  '@rolldown/binding-android-arm64': { os: 'android', cpu: 'arm64' },
  '@rolldown/binding-darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  '@rolldown/binding-darwin-x64': { os: 'darwin', cpu: 'x64' },
  '@rolldown/binding-freebsd-x64': { os: 'freebsd', cpu: 'x64' },
  '@rolldown/binding-linux-arm-gnueabihf': { os: 'linux', cpu: 'arm' },
  '@rolldown/binding-linux-arm64-gnu': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  '@rolldown/binding-linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl' },
  '@rolldown/binding-linux-ppc64-gnu': { os: 'linux', cpu: 'ppc64', libc: 'glibc' },
  '@rolldown/binding-linux-s390x-gnu': { os: 'linux', cpu: 's390x', libc: 'glibc' },
  '@rolldown/binding-linux-x64-gnu': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  '@rolldown/binding-linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
  '@rolldown/binding-openharmony-arm64': { os: 'openharmony', cpu: 'arm64' },
  '@rolldown/binding-win32-arm64-msvc': { os: 'win32', cpu: 'arm64' },
  '@rolldown/binding-win32-x64-msvc': { os: 'win32', cpu: 'x64' },
};

describe('cross-platform Rolldown lock metadata', () => {
  it('locks every official optional binding at the base version with its published OS and CPU', () => {
    const base = lock.packages['node_modules/rolldown'];
    expect(base?.version).toBeTruthy();
    expect(base?.optionalDependencies).toBeTruthy();
    expect(Object.keys(base!.optionalDependencies!).sort()).toEqual(Object.keys(officialPlatforms).sort());

    for (const [name, platform] of Object.entries(officialPlatforms)) {
      const version = base!.optionalDependencies![name];
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, `${name} must be present for cross-platform installs`).toBeTruthy();
      expect(entry!.version).toBe(version);
      expect(entry!.optional).toBe(true);
      expect(entry!.os).toEqual([platform.os]);
      expect(entry!.cpu).toEqual([platform.cpu]);
      if (platform.libc) expect(entry!.libc).toEqual([platform.libc]);
      else expect(entry).not.toHaveProperty('libc');
      expect(entry!.resolved).toBe(`https://registry.npmjs.org/${name}/-/${name.slice('@rolldown/'.length)}-${version}.tgz`);
      expect(entry!.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    }
  });
});
