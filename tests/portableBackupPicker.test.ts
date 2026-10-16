/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PORTABLE_BACKUP_BYTES, pickPortableBackup } from '../src/web/portableBackupPicker';

afterEach(() => vi.restoreAllMocks());

describe('browser portable backup picker', () => {
  it('reads one selected file into bounded memory bytes', async () => {
    const file = new File(['{"format":"still-backup-v5"}'], 'still-backup.json', { type: 'application/json' });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    const selected = await pickPortableBackup();
    expect(selected?.name).toBe(file.name);
    expect(new TextDecoder().decode(selected?.bytes)).toBe('{"format":"still-backup-v5"}');
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('rejects an oversized selection before reading bytes and removes its temporary input', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [{ name: 'too-large.json', size: MAX_PORTABLE_BACKUP_BYTES + 1, arrayBuffer }] });
      this.dispatchEvent(new Event('change'));
    });
    await expect(pickPortableBackup()).rejects.toThrow(/32 MiB/i);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('cleans up when the workspace owner aborts the picker or the browser refuses to open it', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const controller = new AbortController();
    const selection = pickPortableBackup(controller.signal);
    controller.abort();
    await expect(selection).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();

    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
    await expect(pickPortableBackup()).rejects.toThrow(/file picker/i);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
