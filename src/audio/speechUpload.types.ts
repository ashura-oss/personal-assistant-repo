import type { Note } from '../core';
import type { RecoveryFormat } from './recovery.types';
import type { SpeechAudioSnapshot } from '../transcription/types';

export type PreparedSpeechAudio =
  | (SpeechAudioSnapshot & Readonly<{ platform: 'native'; upload: Readonly<{ uri: string; part: NativeSpeechUploadPart }> }>)
  | (SpeechAudioSnapshot & Readonly<{ platform: 'web'; upload: Readonly<{ blob: Blob; fileName: string }> }>)
  | (SpeechAudioSnapshot & Readonly<{ platform: 'server'; upload: Readonly<{ blob: Blob; fileName: string }> }>);

export type NativeSpeechUploadPart = Readonly<{ name: string; type: string; bytes(): Promise<Uint8Array> }>;

export type SpeechAudioService = {
  prepare(note: Note, options: { leaseId: string; maxDurationSeconds: number; maxAudioBytes?: number; signal?: AbortSignal }): Promise<PreparedSpeechAudio>;
  verify(prepared: PreparedSpeechAudio, signal?: AbortSignal): Promise<void>;
  release(leaseId: string): Promise<void>;
  /** Drops private in-memory staging state synchronously without claiming raw I/O settled. */
  disposeMemory?(): void;
};

export type SpeechAudioCrypto = {
  sha256(bytes: Uint8Array): Promise<string>;
};

export type NativeSpeechAudioIO = {
  cacheDirectory: string | null;
  exists(uri: string): Promise<{ exists: boolean; isDirectory?: boolean; size?: number }>;
  makeDirectory(uri: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(uri: string): Promise<void>;
  readHeader(uri: string): Promise<Uint8Array>;
  readBytes(uri: string): Promise<Uint8Array>;
};

export type SpeechAudioFormat = RecoveryFormat;
