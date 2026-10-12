import * as FileSystem from 'expo-file-system/legacy';

function safeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Document path must stay inside the app documents folder.');
  }
  return normalized;
}

/** App documents are written only beneath Expo's private documents directory. */
export async function writePrivateDocument(path: string, content: string): Promise<void> {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error('Private document storage is unavailable on this device.');
  const relative = safeRelativePath(path);
  const parts = relative.split('/');
  const filename = parts.pop()!;
  let directory = root;
  for (const part of parts) {
    directory = `${directory}${part}/`;
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists) await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }
  await FileSystem.writeAsStringAsync(`${directory}${filename}`, content, { encoding: FileSystem.EncodingType.UTF8 });
}
