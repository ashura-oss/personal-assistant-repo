import { dirname, isAbsolute, resolve } from 'node:path';

export const PRIVATE_AUDIO_SCHEMA_VERSION = 4;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUnsupportedDirectorySyncError(platform: NodeJS.Platform, code: unknown): boolean {
  return platform === 'win32' && ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(String(code));
}

export function privateAudioWorkspaceRoot(privateRoot: string, workspaceId: string): string {
  if (!isAbsolute(privateRoot) || privateRoot.includes('\0') || !UUID_V4.test(workspaceId)) throw new Error('audio_root_invalid');
  const base = resolve(privateRoot);
  const root = resolve(base, workspaceId);
  if (dirname(root) !== base) throw new Error('audio_root_invalid');
  return root;
}

export function privateAudioStoragePath(root: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:part|audio)$/i.test(name)) throw new Error('audio_path_invalid');
  const path = resolve(root, name);
  if (dirname(path) !== root) throw new Error('audio_path_invalid');
  return path;
}

export function readPrivateAudioSchemaVersion(db: import('better-sqlite3').Database): number | undefined {
  const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_audio_schema'").get();
  if (!marker) {
    const related = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
      ('private_audio_uploads','private_audio_speech_leases','private_audio_readers','private_audio_capture_uploads','private_audio_cleanup_intents')`).all();
    if (related.length) throw new Error('audio_schema_unversioned');
    return undefined;
  }
  const columns = db.pragma('table_info(private_audio_schema)') as { name: string; type: string; notnull: number; pk: number }[];
  if (columns.length !== 2 || columns[0]?.name !== 'singleton' || columns[0]?.type !== 'INTEGER' || columns[0]?.pk !== 1 ||
      columns[1]?.name !== 'version' || columns[1]?.type !== 'INTEGER' || columns[1]?.notnull !== 1) throw new Error('audio_schema_invalid');
  const versions = db.prepare('SELECT singleton,version FROM private_audio_schema').all() as { singleton: number; version: number }[];
  if (versions.length !== 1 || versions[0]?.singleton !== 1 || ![1, 2, 3, PRIVATE_AUDIO_SCHEMA_VERSION].includes(versions[0]?.version ?? -1)) {
    throw new Error('audio_schema_unsupported');
  }
  return versions[0]!.version;
}

export function assertPrivateAudioSchemaVersion(db: import('better-sqlite3').Database): void {
  if (readPrivateAudioSchemaVersion(db) !== PRIVATE_AUDIO_SCHEMA_VERSION) throw new Error('audio_schema_unsupported');
}

const AUDIO_COLUMNS: Readonly<Record<string, readonly (readonly [string, string, number, number])[]>> = Object.freeze({
  private_audio_schema: [['singleton','INTEGER',0,1],['version','INTEGER',1,0]],
  private_audio_uploads: [['upload_id','TEXT',1,1],['media_id','TEXT',1,0],['workspace_id','TEXT',1,0],['owner_id','TEXT',1,0],['privacy_epoch','INTEGER',1,0],['status','TEXT',1,0],['temp_name','TEXT',1,0],['final_name','TEXT',1,0],['file_name','TEXT',1,0],['format','TEXT',1,0],['mime_type','TEXT',1,0],['expected_bytes','INTEGER',0,0],['sha256','TEXT',0,0],['byte_length','INTEGER',0,0],['duration_seconds','REAL',0,0],['process_id','TEXT',1,0],['created_at','INTEGER',1,0],['updated_at','INTEGER',1,0]],
  private_audio_speech_leases: [['lease_id','TEXT',1,1],['upload_id','TEXT',1,0],['media_id','TEXT',1,0],['workspace_id','TEXT',1,0],['owner_id','TEXT',1,0],['privacy_epoch','INTEGER',1,0],['note_id','TEXT',1,0],['note_revision','INTEGER',1,0],['sha256','TEXT',1,0],['byte_length','INTEGER',1,0],['duration_seconds','REAL',1,0],['process_id','TEXT',1,0],['created_at','INTEGER',1,0]],
  private_audio_readers: [['reader_id','TEXT',1,1],['media_id','TEXT',1,0],['workspace_id','TEXT',1,0],['owner_id','TEXT',1,0],['privacy_epoch','INTEGER',1,0],['process_id','TEXT',1,0],['created_at','INTEGER',1,0]],
  private_audio_capture_uploads: [['upload_id','TEXT',1,1],['capture_id','TEXT',1,0],['capture_revision','TEXT',1,0],['workspace_id','TEXT',1,0],['owner_id','TEXT',1,0],['privacy_epoch','INTEGER',1,0],['captured_at','TEXT',1,0],['time_zone','TEXT',1,0],['mime_type','TEXT',1,0],['expected_bytes','INTEGER',0,0],['media_id','TEXT',1,0],['format','TEXT',1,0],['sha256','TEXT',0,0],['byte_length','INTEGER',0,0],['duration_seconds','REAL',0,0],['status','TEXT',1,0],['failure_code','TEXT',0,0],['consumed_command_id','TEXT',0,0],['note_id','TEXT',0,0],['note_revision','INTEGER',0,0],['created_at','INTEGER',1,0],['updated_at','INTEGER',1,0]],
  private_audio_cleanup_intents: [['intent_id','TEXT',1,1],['workspace_id','TEXT',1,0],['owner_id','TEXT',1,0],['privacy_epoch','INTEGER',1,0],['media_id','TEXT',1,0],['source_note_id','TEXT',1,0],['snapshot_revision','INTEGER',1,0],['command_id','TEXT',0,0],['status','TEXT',1,0],['created_at','INTEGER',1,0],['updated_at','INTEGER',1,0]],
});

/** Exact v4 schema proof shared by repository initialization and cold recovery. */
export function assertPrivateAudioSchema(db: import('better-sqlite3').Database): void {
  assertPrivateAudioSchemaVersion(db);
  for (const [table, expected] of Object.entries(AUDIO_COLUMNS)) {
    const actual = db.pragma(`table_info(${table})`) as { name: string; type: string; notnull: number; pk: number }[];
    if (actual.length !== expected.length || actual.some((column, index) => {
      const [name, type, notnull, pk] = expected[index]!;
      return column.name !== name || column.type.toUpperCase() !== type || column.notnull !== notnull || column.pk !== pk;
    })) throw new Error(`audio_schema_invalid:${table}`);
    const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table) as { strict?: number } | undefined;
    if (strict?.strict !== 1) throw new Error(`audio_schema_invalid:${table}`);
  }
  const requiredIndexes: Readonly<Record<string, readonly string[]>> = {
    private_audio_uploads: ['media_id'],
    private_audio_capture_uploads: ['capture_id'],
    private_audio_cleanup_intents: ['workspace_id,owner_id,privacy_epoch,media_id'],
  };
  for (const [table, expected] of Object.entries(requiredIndexes)) {
    const indexes = db.pragma(`index_list(${table})`) as { name: string; unique: number }[];
    const unique = indexes.filter((index) => index.unique === 1).map((index) => {
      const columns = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[];
      return columns.map((column) => column.name).join(',');
    });
    for (const columns of expected) if (!unique.includes(columns)) throw new Error(`audio_schema_invalid:${table}`);
  }
}
