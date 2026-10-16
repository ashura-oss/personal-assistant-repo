export const MAX_PORTABLE_BACKUP_BYTES = 32 * 1024 * 1024;

export type PickedPortableBackup = Readonly<{ name: string; bytes: Uint8Array }>;

/** Browser-only picker. It never reads a URI or copies the selected file to persistent storage. */
export function pickPortableBackup(signal?: AbortSignal): Promise<PickedPortableBackup | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.reject(new Error('Choose a backup from a browser workspace.'));
  }
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.multiple = false;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    let settled = false;
    let focusTimer: number | undefined;
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocus);
      signal?.removeEventListener('abort', onAbort);
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      input.remove();
    };
    const finish = (value: PickedPortableBackup | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onCancel = () => finish(null);
    const onFocus = () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (!settled && input.files?.length !== 1) finish(null);
      }, 250);
    };
    const onAbort = () => finish(null);
    const onChange = async () => {
      const file = input.files?.length === 1 ? input.files[0] : undefined;
      if (!file) return finish(null);
      if (!Number.isSafeInteger(file.size) || file.size <= 0) return fail(new Error('Could not verify the selected backup size.'));
      if (file.size > MAX_PORTABLE_BACKUP_BYTES) return fail(new Error('Backup files must be 32 MiB or smaller.'));
      try {
        const buffer = await file.arrayBuffer();
        if (signal?.aborted) return finish(null);
        if (buffer.byteLength !== file.size || buffer.byteLength > MAX_PORTABLE_BACKUP_BYTES) {
          return fail(new Error('The selected file changed while Still was reading it. Choose the backup again.'));
        }
        finish(Object.freeze({ name: file.name, bytes: new Uint8Array(buffer) }));
      } catch {
        fail(new Error('Still could not read the selected backup. Choose it again.'));
      }
    };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus);
    signal?.addEventListener('abort', onAbort, { once: true });
    document.body.append(input);
    try { input.click(); }
    catch { fail(new Error('Still could not open the local file picker.')); }
  });
}
