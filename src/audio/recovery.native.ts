import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { AudioDurationProbeError, measureNativeAudioDuration } from './audioDurationProbe.native';
import {
  assertRecoveryByteLength,
  boundedRecoveryDuration,
  MAX_DURATION_SECONDS,
  RECOVERY_FORMATS,
  safeAudioFileName,
  validateRecoveryFormat,
} from './formats';
import type { AudioRecoveryMetadata, RecordingRecoveryService, StagedRecording } from './recovery.types';

const PRIVATE_FOLDER = 'recording-recovery/';
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hashBytes(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, input).then(digest => bytesToHex(new Uint8Array(digest)));
}

function safePrivateUri(uri: string): boolean {
  const directory = FileSystem.documentDirectory;
  if (!directory || !uri.startsWith(`${directory}${PRIVATE_FOLDER}`)) return false;
  const tail = uri.slice(`${directory}${PRIVATE_FOLDER}`.length);
  return new RegExp(`^${UUID_PATTERN}\\.(m4a|mp3|wav|webm|ogg)$`, 'i').test(tail);
}

async function ensurePrivateFolder(): Promise<string> {
  if (!FileSystem.documentDirectory) throw new Error('Private app storage is unavailable on this device.');
  const folder = `${FileSystem.documentDirectory}${PRIVATE_FOLDER}`;
  const info = await FileSystem.getInfoAsync(folder);
  if (!info.exists) await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  else if (!info.isDirectory) throw new Error('Private app storage is unavailable on this device.');
  return folder;
}

async function fileSize(uri: string): Promise<number> {
  const file = new File(uri);
  if (!file.exists) throw new Error('The selected audio file is unavailable.');
  assertRecoveryByteLength(file.size);
  return file.size;
}

async function readBytes(uri: string, expectedSize: number): Promise<Uint8Array> {
  const bytes = await new File(uri).bytes();
  assertRecoveryByteLength(bytes.byteLength);
  if (bytes.byteLength !== expectedSize) throw new Error('The selected recording changed while it was being read.');
  return bytes;
}

async function probeDuration(uri: string, maxDurationSeconds: number): Promise<Pick<AudioRecoveryMetadata, 'durationStatus' | 'durationSeconds'>> {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
  try {
    const measurement = await measureNativeAudioDuration(uri);
    if (measurement.outcome === 'unknown') {
      if (measurement.reason === 'zero') return boundedRecoveryDuration(0, Math.min(MAX_DURATION_SECONDS, maxDurationSeconds));
      return { durationStatus: 'unknown' };
    }
    return boundedRecoveryDuration(measurement.durationSeconds, Math.min(MAX_DURATION_SECONDS, maxDurationSeconds));
  } catch (error) {
    if (error instanceof AudioDurationProbeError) {
      if (error.code === 'timeout') throw new Error('The selected recording did not finish loading within 10 seconds.');
      if (error.code === 'decode_error') throw new Error('The selected recording could not be decoded as audio.');
      if (error.code === 'invalid_duration') throw new Error('The audio duration is invalid.');
    }
    throw error;
  }
}

async function inspectBytes(uri: string, fileName: string, mimeType: string, maxDurationSeconds: number): Promise<AudioRecoveryMetadata> {
  if (!safePrivateUri(uri)) throw new Error('This staged recording is not owned by the recovery service.');
  const size = await fileSize(uri);
  const bytes = await readBytes(uri, size);
  const format = validateRecoveryFormat(fileName, mimeType, bytes);
  const sha256 = await hashBytes(bytes);
  const duration = await probeDuration(uri, maxDurationSeconds);
  return { fileName: safeAudioFileName(fileName, format), format, mimeType: RECOVERY_FORMATS[format].mimeType, byteLength: bytes.byteLength, sha256, ...duration };
}

export const recordingRecoveryService: RecordingRecoveryService = {
  async pickAndStage({ maxDurationSeconds }) {
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
    const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], multiple: false, copyToCacheDirectory: true, base64: false });
    if (result.canceled) return null;
    if (result.assets.length !== 1) throw new Error('Choose one audio file at a time.');
    const asset = result.assets[0];
    if (!asset || !asset.uri.startsWith('file://')) throw new Error('The picker did not provide a copied local file. Choose a local audio file and try again.');
    const sourceSize = await fileSize(asset.uri); // bounds before copying or reading
    const folder = await ensurePrivateFolder();
    const id = Crypto.randomUUID();
    const mimeType = asset.mimeType ?? '';
    // Use a private temporary leaf until the copied bytes establish the real format.
    const temporaryUri = `${folder}${id}.stage`;
    try {
      await FileSystem.copyAsync({ from: asset.uri, to: temporaryUri });
      if (await fileSize(asset.uri) !== sourceSize) throw new Error('The selected recording changed while it was being copied.');
      const stagedSize = await fileSize(temporaryUri); // bounds again after copying
      const stagedBytes = await readBytes(temporaryUri, stagedSize);
      if (stagedSize !== sourceSize) throw new Error('The selected recording changed while it was being copied.');
      if (await fileSize(temporaryUri) !== stagedSize) throw new Error('The selected recording changed while it was being copied.');
      const format = validateRecoveryFormat(asset.name, mimeType, stagedBytes);
      const stagedUri = `${folder}${id}.${format}`;
      await FileSystem.moveAsync({ from: temporaryUri, to: stagedUri });
      const sha256 = await hashBytes(stagedBytes);
      const duration = await probeDuration(stagedUri, maxDurationSeconds);
      return {
        uri: stagedUri,
        metadata: {
          fileName: safeAudioFileName(asset.name, format),
          format,
          mimeType: RECOVERY_FORMATS[format].mimeType,
          byteLength: stagedSize,
          sha256,
          ...duration,
        },
      };
    } catch (error) {
      // This UUID destination is fresh and private, even when copyAsync failed midway.
      for (const extension of ['stage', 'm4a', 'mp3', 'wav', 'webm', 'ogg']) {
        await FileSystem.deleteAsync(`${folder}${id}.${extension}`, { idempotent: true }).catch(() => undefined);
      }
      throw error;
    }
  },
  async inspect(staged: StagedRecording, { maxDurationSeconds }) {
    const metadata = await inspectBytes(staged.uri, staged.metadata.fileName, staged.metadata.mimeType, maxDurationSeconds);
    if (metadata.byteLength !== staged.metadata.byteLength || metadata.sha256 !== staged.metadata.sha256 || metadata.format !== staged.metadata.format) {
      throw new Error('The staged recording has changed since it was selected.');
    }
    return metadata;
  },
  async remove(staged) {
    if (!safePrivateUri(staged.uri)) throw new Error('This staged recording is not owned by the recovery service.');
    await FileSystem.deleteAsync(staged.uri, { idempotent: true });
  },
};
