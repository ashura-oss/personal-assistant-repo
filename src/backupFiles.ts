import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Platform } from "react-native";

export const MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;

export interface PickedBackupFile {
  name: string;
  bytes: Uint8Array;
}

function checkSize(size: number | undefined): number {
  if (!Number.isSafeInteger(size) || size! < 0) {
    throw new Error("Still could not verify this file's size. Choose a local JSON backup file.");
  }
  if (size! > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Backup files must be 32 MiB or smaller.");
  }
  return size!;
}

/** Opens one user-selected local JSON file and returns bounded bytes without fetching its URI. */
export async function pickPortableBackup(): Promise<PickedBackupFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "application/json",
    multiple: false,
    copyToCacheDirectory: true,
    base64: false,
  });
  if (result.canceled) return null;
  if (result.assets.length !== 1) {
    throw new Error("Choose one JSON backup file at a time.");
  }

  const asset = result.assets[0];
  const reportedSize = asset.size ?? asset.file?.size;
  if (reportedSize !== undefined) checkSize(reportedSize);

  if (Platform.OS === "web") {
    const file = asset.file;
    if (!file) {
      throw new Error("Your browser did not provide the selected local file. Try choosing it again.");
    }
    const actualSize = checkSize(file.size);
    if (reportedSize !== undefined && actualSize !== reportedSize) {
      throw new Error("The selected file size changed. Choose the backup again.");
    }
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_BACKUP_FILE_BYTES || buffer.byteLength !== actualSize) {
      throw new Error("The selected file changed while Still was reading it. Choose the backup again.");
    }
    if (buffer.byteLength === 0) throw new Error("The selected backup file is empty.");
    return { name: asset.name, bytes: new Uint8Array(buffer) };
  }

  if (!asset.uri.startsWith("file://")) {
    throw new Error("Still can only read a local copy selected from the file picker.");
  }
  const localFile = new File(asset.uri);
  if (!localFile.exists) throw new Error("The selected local backup file is no longer available.");
  const actualSize = checkSize(localFile.size);
  if (reportedSize !== undefined && actualSize !== reportedSize) {
    throw new Error("The selected file size changed. Choose the backup again.");
  }
  const bytes = await localFile.bytes();
  if (bytes.byteLength > MAX_BACKUP_FILE_BYTES || bytes.byteLength !== actualSize) {
    throw new Error("The selected file changed while Still was reading it. Choose the backup again.");
  }
  if (bytes.byteLength === 0) throw new Error("The selected backup file is empty.");
  return { name: asset.name, bytes };
}
