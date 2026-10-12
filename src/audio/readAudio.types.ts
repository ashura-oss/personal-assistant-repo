export type AudioUpload =
  | { platform: 'native'; uri: string; fileName: string; mimeType: string }
  | { platform: 'web'; blob: Blob; fileName: string; mimeType: string };
