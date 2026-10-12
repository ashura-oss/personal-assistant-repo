import type {
  AssistantCitation, AssistantDecision, AssistantIntent, AssistantProposal, AssistantResponse,
  AssistantSource, AssistantSourceInput, BoundedLocalSourceSet, ContextSelection, LocalContextSnapshotInput, OfflinePreviewInput, SourceCatalog,
} from './types';
export type { AssistantCitation, AssistantDecision, AssistantIntent, AssistantProposal, AssistantResponse,
  AssistantSource, AssistantSourceInput, AssistantSourceKind, BoundedLocalSourceSet, ContextSelection, LocalContextSnapshotInput, OfflinePreviewInput, SourceCatalog } from './types';

const MAX_SOURCES = 200;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_VERSION_BYTES = 1024 * 1024;
const MAX_SCAN_PER_KIND = 5_000;
const MAX_MAIL_PER_ACCOUNT = 200;
const MAX_OMITTED_SOURCE_IDS = 100;
const MAX_SUPPLEMENTAL = 5;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const normalizeSourceText = (value: string) => value.replace(/\r\n?/g, '\n').normalize('NFC');

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) { this.#map = new Map(entries); Object.freeze(this); }
  get size(): number { return this.#map.size; }
  get(key: K): V | undefined { return this.#map.get(key); }
  has(key: K): boolean { return this.#map.has(key); }
  entries(): MapIterator<[K, V]> { return this.#map.entries(); }
  keys(): MapIterator<K> { return this.#map.keys(); }
  values(): MapIterator<V> { return this.#map.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#map[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ReadonlyMap'; }
}

export type Sha256 = (value: Uint8Array) => Promise<string>;

function safeSourceLabel(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}

function requireStableIdentity(identityKey: string | undefined): string | undefined {
  if (!identityKey || identityKey.length > 1024 || /[\u0000-\u001f\u007f]/.test(identityKey)) return undefined;
  return identityKey;
}

/** Scans bounded metadata, ranks before hashing, and returns a small source set plus omission metadata. */
export function buildLocalSourceSet(input: LocalContextSnapshotInput): BoundedLocalSourceSet {
  if (!Number.isSafeInteger(input.transcript.revision) || input.transcript.revision < 0) throw new Error('Current transcript revision is invalid.');
  const query = input.query?.slice(0, 2000) ?? '';
  const taskQuery = input.intent === 'answer' && /\b(task|tasks|task count|how many)\b/i.test(query);
  const calendarQuery = input.intent === 'answer' && /\b(calendar|event|meeting|upcoming|tomorrow|today|next)\b/i.test(query);
  const candidates: AssistantSourceInput[] = [{ id: 'transcript', revision: input.transcript.revision, text: input.transcript.text, required: true, kind: 'note', title: 'Current transcript' }];
  let omittedSourceCount = 0;
  const omittedSourceIds: string[] = [];
  const omittedSet = new Set<string>();
  const omit = (id: string) => {
    omittedSourceCount++;
    if (omittedSourceIds.length < MAX_OMITTED_SOURCE_IDS && !omittedSet.has(id)) { omittedSourceIds.push(id); omittedSet.add(id); }
  };
  const addCandidate = (source: AssistantSourceInput) => { candidates.push(source); };
  const isRequiredDocument = (path: string) => /^memory\/(RULES|ROUTINES)\.md$/i.test(path);

  const docs = input.documents ?? [];
  const docScan = docs.slice(0, MAX_SCAN_PER_KIND);
  const requiredDocs = docs.filter((doc) => isRequiredDocument(doc.path));
  for (const document of [...docScan, ...requiredDocs]) {
    const id = `doc:${document.path}`;
    if (candidates.some((candidate) => candidate.id === id)) continue;
    addCandidate({ id, revision: document.revision, text: document.content, required: isRequiredDocument(document.path), kind: 'document', title: safeSourceLabel(document.path), updatedAt: document.updatedAt });
  }
  for (const document of docs.slice(MAX_SCAN_PER_KIND)) if (!isRequiredDocument(document.path)) omit(`doc:${document.path}`);

  const tasks = input.tasks ?? [];
  const taskScan = tasks.slice(0, MAX_SCAN_PER_KIND);
  for (const task of taskScan) {
    addCandidate({ id: `task:${encodeURIComponent(task.id)}`, revision: 0, text: [`Task: ${safeSourceLabel(task.title)}`, `Status: ${safeSourceLabel(task.status)}`, task.dueAt ? `Due: ${safeSourceLabel(task.dueAt)}` : '', safeSourceLabel(task.body.slice(0, 4_000))].filter(Boolean).join('\n'), required: false, kind: 'task', title: safeSourceLabel(task.title), updatedAt: task.updatedAt });
  }
  for (const task of tasks.slice(MAX_SCAN_PER_KIND)) omit(`task:${encodeURIComponent(task.id)}`);
  if (taskQuery) {
    // This compact aggregate fingerprints every task identity/status/date without hashing bodies or titles.
    const indexRows = tasks.map((task) => [task.id, task.status, task.dueAt ?? '']);
    const open = tasks.filter((task) => task.status === 'open').length;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const versionMaterial = JSON.stringify({ total: tasks.length, indexed: indexRows });
    if (byteLength(versionMaterial) <= MAX_VERSION_BYTES) {
      addCandidate({ id: 'task:index', revision: 0, text: `Task list snapshot: ${tasks.length} total; ${open} open; ${completed} completed.`, versionMaterial, required: true, kind: 'task', title: 'Task index' });
    } else omit('task:index');
  }

  const calendars = input.calendars ?? [];
  const connectedCalendar = new Map<string, (typeof calendars)[number]>();
  for (const calendar of calendars.slice(0, MAX_SCAN_PER_KIND)) {
    const identityKey = requireStableIdentity(calendar.identityKey);
    if (!identityKey || !calendar.connected) continue;
    const providerId = calendar.providerId ?? calendar.id;
    connectedCalendar.set(`${calendar.accountId}\n${calendar.id}`, calendar);
    addCandidate({ id: `calendar:${encodeURIComponent(identityKey)}:${encodeURIComponent(providerId)}`, revision: 0,
      text: [`Calendar: ${safeSourceLabel(calendar.name)}`, `Writable: ${calendar.writable ? 'yes' : 'no'}`, 'Connected: yes'].join('\n'), required: false, kind: 'calendar', title: safeSourceLabel(calendar.name) });
  }
  for (const calendar of calendars.slice(MAX_SCAN_PER_KIND)) omit(`calendar:${encodeURIComponent(calendar.identityKey ?? 'unbound')}:${encodeURIComponent(calendar.providerId ?? calendar.id)}`);

  const events = input.calendarEvents ?? [];
  for (const event of events.slice(0, MAX_SCAN_PER_KIND)) {
    const identityKey = requireStableIdentity(event.identityKey);
    if (!identityKey || !event.providerEventId) continue;
    const calendar = connectedCalendar.get(`${event.accountId}\n${event.calendarId}`);
    if (!calendar || requireStableIdentity(calendar.identityKey) !== identityKey) continue;
    addCandidate({ id: `calendar-event:${encodeURIComponent(identityKey)}:${encodeURIComponent(calendar.providerId ?? calendar.id)}:${encodeURIComponent(event.providerEventId)}`, revision: 0,
      text: [`Event: ${safeSourceLabel(event.subject ?? '(untitled)')}`, `Start: ${safeSourceLabel(event.start ?? '(not available)')}`, `End: ${safeSourceLabel(event.end ?? '(not available)')}`, `Time zone: ${safeSourceLabel(event.timeZone ?? '(not available)')}`].join('\n'), required: false, kind: 'calendar', title: safeSourceLabel(event.subject ?? 'Calendar event') });
  }
  for (const event of events.slice(MAX_SCAN_PER_KIND)) omit(`calendar-event:${encodeURIComponent(event.identityKey ?? 'unbound')}:${encodeURIComponent(event.providerEventId)}`);
  if (calendarQuery && input.calendarSnapshot && requireStableIdentity(input.calendarSnapshot.identityKey)
    && Number.isFinite(Date.parse(input.calendarSnapshot.timeMin)) && Number.isFinite(Date.parse(input.calendarSnapshot.timeMax))
    && Date.parse(input.calendarSnapshot.timeMin) < Date.parse(input.calendarSnapshot.timeMax)
    && Number.isFinite(Date.parse(input.calendarSnapshot.asOf))) {
    const snapshot = input.calendarSnapshot;
    const rows = snapshot.events.slice(0, MAX_SCAN_PER_KIND).map((event) => [event.providerEventId, event.subject ?? '', event.start ?? '', event.end ?? '', event.timeZone ?? ''].join('\t'));
    const visibleRows = snapshot.events.slice(0, 50).map((event) => `${safeSourceLabel(event.subject ?? '(untitled)')} | ${safeSourceLabel(event.start ?? '(date unavailable)')} | ${safeSourceLabel(event.timeZone ?? '(time zone unavailable)')}`);
    const overflow = snapshot.events.length > visibleRows.length;
    const metadata = `Calendar snapshot for a bounded range: ${snapshot.timeMin} to ${snapshot.timeMax}; synced as of ${snapshot.asOf}; partial=${snapshot.partial ? 'yes' : 'no'}${overflow ? `; showing ${visibleRows.length} of ${snapshot.events.length} events` : ''}.`;
    const text = [metadata, ...visibleRows].join('\n');
    if (byteLength(text) <= MAX_SOURCE_BYTES && byteLength(JSON.stringify({ range: [snapshot.timeMin, snapshot.timeMax], asOf: snapshot.asOf, partial: snapshot.partial, events: rows })) <= MAX_VERSION_BYTES) {
      addCandidate({ id: `calendar:index:${encodeURIComponent(snapshot.identityKey)}`, revision: 0, text,
        versionMaterial: JSON.stringify({ range: [snapshot.timeMin, snapshot.timeMax], asOf: snapshot.asOf, partial: snapshot.partial, events: rows }),
        required: true, kind: 'calendar', title: 'Calendar snapshot' });
    }
  }

  const mailbox = input.mailbox ?? [];
  const mailScan = mailbox.slice(0, MAX_SCAN_PER_KIND);
  const perIdentityCount = new Map<string, number>();
  for (const message of mailScan) {
    const identityKey = requireStableIdentity(message.identityKey);
    if (!identityKey || !message.providerMessageId) { omit(`mail:unbound:${encodeURIComponent(message.providerMessageId ?? message.id)}`); continue; }
    const count = perIdentityCount.get(identityKey) ?? 0;
    if (count >= MAX_MAIL_PER_ACCOUNT) { omit(`mail:${encodeURIComponent(identityKey)}:${encodeURIComponent(message.providerMessageId)}`); continue; }
    perIdentityCount.set(identityKey, count + 1);
    addCandidate({ id: `mail:${encodeURIComponent(identityKey)}:${encodeURIComponent(message.providerMessageId)}`, revision: 0,
      text: [`Subject: ${safeSourceLabel(message.subject ?? '(no subject)')}`, `From: ${safeSourceLabel(message.from ?? '(unknown sender)')}`, `Received: ${safeSourceLabel(message.receivedAt ?? '(unknown time)')}`, `Preview: ${safeSourceLabel(message.snippet ?? '').slice(0, 2_000)}`].join('\n'), required: false, kind: 'mail', title: safeSourceLabel(message.subject ?? 'Email message'), updatedAt: message.receivedAt });
  }
  for (const message of mailbox.slice(MAX_SCAN_PER_KIND)) omit(`mail:${encodeURIComponent(message.identityKey)}:${encodeURIComponent(message.providerMessageId)}`);

  const required = candidates.filter((source) => source.required || source.id === 'transcript' || (source.kind === 'document' && isRequiredDocument(source.id)));
  const requiredIds = new Set(required.map((source) => source.id));
  const queryTerms = terms(query).slice(0, 256);
  const transcriptTerms = terms(input.transcript.text).slice(0, 256);
  const ids = explicitIds(query);
  const scored = candidates.filter((source) => !requiredIds.has(source.id)).map((source, index) => ({ source, index, score: scoreSource(source, queryTerms, transcriptTerms, ids) }));
  scored.sort((a, b) => b.score - a.score || (b.source.updatedAt ?? '').localeCompare(a.source.updatedAt ?? '') || a.index - b.index);
  const room = Math.max(0, MAX_SOURCES - required.length);
  const selected = scored.filter(({ score }) => score > 0).slice(0, room).map(({ source }) => source);
  const selectedIds = new Set([...required, ...selected].map((source) => source.id));
  for (const { source } of scored) if (!selectedIds.has(source.id)) omit(source.id);
  const deduped = new Map([...required, ...selected].map((source) => [source.id, source]));
  const ordered = [...deduped.values()].sort((a, b) => Number(b.id === 'transcript') - Number(a.id === 'transcript') || a.id.localeCompare(b.id));
  return { sources: ordered, omittedSourceCount, omittedSourceIds: omittedSourceIds.slice(0, MAX_OMITTED_SOURCE_IDS) };
}

/** Backwards-compatible source-only wrapper; callers needing omission metadata use buildLocalSourceSet. */
export function buildLocalSourceInputs(input: LocalContextSnapshotInput): AssistantSourceInput[] {
  return buildLocalSourceSet(input).sources;
}

function validRevision(value: string | number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Builds an immutable, locally hashed snapshot. Hashing is injected so this module has no platform/runtime dependency. */
export async function createSourceCatalog(inputs: readonly AssistantSourceInput[], sha256: Sha256): Promise<SourceCatalog> {
  if (inputs.length > MAX_SOURCES) throw new Error(`Local context is limited to ${MAX_SOURCES} sources.`);
  if (typeof sha256 !== 'function') throw new Error('A local SHA-256 implementation is required to fingerprint source snapshots.');
  const sources: AssistantSource[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!input.id || input.id.length > 512 || /[\u0000-\u001f\u007f]/.test(input.id) || seen.has(input.id)) throw new Error('Context source IDs must be unique, stable, and bounded.');
    if (!validRevision(input.revision)) throw new Error(`Context source ${input.id} has an invalid revision.`);
    if (typeof input.required !== 'boolean' || (input.kind !== undefined && !['note', 'document', 'task', 'calendar', 'mail'].includes(input.kind)) || (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000))) throw new Error(`Context source ${input.id} has invalid metadata.`);
    if (typeof input.text !== 'string' || byteLength(input.text) > MAX_SOURCE_BYTES || (input.versionMaterial !== undefined && (typeof input.versionMaterial !== 'string' || byteLength(input.versionMaterial) > MAX_VERSION_BYTES))) throw new Error(`Context source ${input.id} is too large to validate safely.`);
    if (input.updatedAt !== undefined && !Number.isFinite(Date.parse(input.updatedAt))) throw new Error(`Context source ${input.id} has an invalid update time.`);
    const contentHash = (await sha256(encoder.encode(normalizeSourceText(input.versionMaterial ?? input.text)))).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('The local SHA-256 implementation returned an invalid digest.');
    const { versionMaterial: _versionMaterial, ...publicInput } = input;
    const source: AssistantSource = Object.freeze({ ...publicInput, contentHash, version: `${String(input.revision)}:${contentHash}` });
    sources.push(source);
    seen.add(input.id);
  }
  const byId = new ReadonlyMapView(sources.map((source) => [source.id, source] as const));
  return Object.freeze({ sources: Object.freeze(sources), byId });
}

export interface SelectContextOptions {
  query?: string;
  transcript?: string;
  transcriptSourceId?: string;
  byteBudget: number;
  buildBody: (context: string) => string;
  now?: number;
  maxSupplementalSources?: number;
  preselection?: { omittedSourceCount: number; omittedSourceIds: readonly string[] };
}

function sourceBlock(source: AssistantSource, excerpt: string): string {
  const title = (source.title ?? source.id).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 300);
  const sourceId = JSON.stringify(source.id);
  return `### ${title} [sourceId=${sourceId}; revision=${String(source.revision)}; sourceVersion=${source.version}; kind=${source.kind ?? 'local'}]\n${excerpt}`;
}

function terms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))];
}

function explicitIds(query: string): string[] {
  return [...query.matchAll(/\b(?:project|person|task|note|calendar|mail)\s*[:#]\s*([\p{L}\p{N}._-]{2,128})/giu)].map((match) => match[1].toLocaleLowerCase());
}

function scoreSource(source: Pick<AssistantSourceInput, 'id' | 'text' | 'kind' | 'updatedAt'>, queryTerms: string[], transcriptTerms: string[], ids: string[]): number {
  const lowerId = source.id.toLocaleLowerCase();
  const lowerText = source.text.toLocaleLowerCase();
  const sourceTerms = new Set(terms(lowerText));
  let score = ids.reduce((sum, id) => sum + (lowerId.includes(id) ? 2000 : lowerText.includes(id) ? 500 : 0), 0);
  for (const term of queryTerms) {
    if (lowerId.includes(term)) score += 100;
    if (sourceTerms.has(term)) score += 20;
  }
  for (const term of transcriptTerms) if (sourceTerms.has(term)) score += 1;
  if (source.kind === 'document' && /(?:^|\/)profile\.md$/i.test(source.id)) score += 1000;
  return score;
}

function relevantWindow(value: string, count: number, query: string): string {
  const characters = [...value];
  if (count >= characters.length) return value;
  const lower = value.toLocaleLowerCase();
  const matchOffsets = terms(query).map((term) => lower.indexOf(term)).filter((offset) => offset >= 0);
  if (!matchOffsets.length) return characters.slice(0, count).join('');
  const match = Math.min(...matchOffsets);
  const point = [...value.slice(0, match)].length;
  const start = Math.max(0, Math.min(characters.length - count, point - Math.floor(count / 3)));
  return characters.slice(start, start + count).join('');
}

function excerptThatFits(source: AssistantSource, existing: string[], options: SelectContextOptions): string | undefined {
  const full = source.text;
  const render = (text: string) => [...existing, sourceBlock(source, text)].join('\n\n');
  if (byteLength(options.buildBody(render(full))) <= options.byteBudget) return full;
  const characters = [...full];
  let low = 0, high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const excerpt = relevantWindow(full, mid, options.query ?? '');
    if (byteLength(options.buildBody(render(excerpt))) <= options.byteBudget) low = mid;
    else high = mid - 1;
  }
  if (low === 0) return undefined;
  return relevantWindow(full, low, options.query ?? '');
}

/** Selects deterministic exact excerpts while accounting for escaped JSON/schema overhead via buildBody. */
export function selectContext(catalog: SourceCatalog, options: SelectContextOptions): ContextSelection {
  const transcriptSourceId = options.transcriptSourceId ?? 'transcript';
  const transcript = catalog.byId.get(transcriptSourceId);
  if (!transcript) throw new Error('The current transcript source is missing from the context snapshot.');
  if (options.transcript !== undefined && options.transcript !== transcript.text) throw new Error('The context snapshot does not match the current transcript.');
  if (!Number.isFinite(options.byteBudget) || options.byteBudget < 1) throw new Error('Request body budget is invalid.');

  const isCoreMemory = (source: AssistantSource, file: string) => source.kind === 'document' && new RegExp(`(?:^|/)${file}\\.md$`, 'i').test(source.id);
  const required = catalog.sources.filter((source) => source.required || source.id === transcriptSourceId || isCoreMemory(source, 'RULES') || isCoreMemory(source, 'ROUTINES'));
  // Put the transcript first; then user-authored rules and other required content. Preserve caller order for ties.
  required.sort((a, b) => Number(b.id === transcriptSourceId) - Number(a.id === transcriptSourceId) || a.id.localeCompare(b.id));
  let blocks: string[] = [];
  const excerpts = Object.create(null) as Record<string, string>;
  for (const source of required) {
    blocks.push(sourceBlock(source, source.text));
    if (byteLength(options.buildBody(blocks.join('\n\n'))) > options.byteBudget) {
      throw new Error(`Required context source ${source.id} and the full transcript do not fit the request limit.`);
    }
    excerpts[source.id] = source.text;
  }

  const alreadyIncluded = new Set(required.map((source) => source.id));
  const query = options.query ?? '';
  const relevantTerms = terms(query.slice(0, 2000)).slice(0, 256);
  const transcriptTerms = terms(options.transcript ?? transcript.text).slice(0, 256);
  const ids = explicitIds(query);
  const candidates = catalog.sources.filter((source) => !alreadyIncluded.has(source.id))
    .map((source, index) => ({ source, index, score: scoreSource(source, relevantTerms, transcriptTerms, ids) }))
    .sort((a, b) => b.score - a.score || (b.source.updatedAt ?? '').localeCompare(a.source.updatedAt ?? '') || a.index - b.index)
    .filter(({ source, score }) => score > 0 || (source.kind === 'document' && /(?:^|\/)profile\.md$/i.test(source.id)));
  const requestedSupplemental = options.maxSupplementalSources ?? MAX_SUPPLEMENTAL;
  const maxSupplemental = Number.isFinite(requestedSupplemental) ? Math.max(0, Math.min(MAX_SUPPLEMENTAL, Math.floor(requestedSupplemental))) : MAX_SUPPLEMENTAL;
  let selected = 0;
  const included = new Set(alreadyIncluded);
  for (const { source } of candidates) {
    if (selected >= maxSupplemental) break;
    const excerpt = excerptThatFits(source, blocks, options);
    if (excerpt === undefined) continue;
    blocks = [...blocks, sourceBlock(source, excerpt)];
    excerpts[source.id] = excerpt;
    included.add(source.id);
    selected++;
  }
  const context = blocks.join('\n\n');
  if (byteLength(options.buildBody(context)) > options.byteBudget) throw new Error('Selected context exceeds the serialized request limit.');
  const omittedInCatalog = catalog.sources.filter((source) => !included.has(source.id)).map((source) => source.id);
  const omittedSourceIds = [...new Set([...(options.preselection?.omittedSourceIds ?? []), ...omittedInCatalog])].slice(0, MAX_OMITTED_SOURCE_IDS);
  const omittedSourceCount = Math.max(0, options.preselection?.omittedSourceCount ?? 0) + omittedInCatalog.length;
  return Object.freeze({ context, includedSourceIds: [...included], omittedSourceIds, omittedSourceCount, excerpts: Object.freeze(excerpts) });
}

export const assistantResponseSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'answer', 'decisions', 'citations', 'clarifications', 'proposals'],
  properties: {
    summary: { type: 'string', maxLength: 3000 }, answer: { type: 'string', maxLength: 6000 },
    decisions: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['text', 'sourceId', 'revision', 'sourceVersion', 'quote'], properties: { text: { type: 'string', maxLength: 1000 }, sourceId: { type: 'string', maxLength: 512 }, revision: { type: 'integer', minimum: 0 }, sourceVersion: { type: 'string', maxLength: 320 }, quote: { type: 'string', maxLength: 1000 } } } },
    citations: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['sourceId', 'revision', 'sourceVersion', 'quote'], properties: { sourceId: { type: 'string', maxLength: 512 }, revision: { type: 'integer', minimum: 0 }, sourceVersion: { type: 'string', maxLength: 320 }, quote: { type: 'string', maxLength: 1000 } } } },
    clarifications: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 1000 } },
    proposals: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'body', 'recipients', 'dueAt', 'evidence'], properties: {
      kind: { type: 'string', enum: ['task', 'reminder', 'email', 'event', 'memory'] }, title: { type: 'string', maxLength: 140 }, body: { type: 'string', maxLength: 2000 },
      recipients: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 320 } }, dueAt: { type: ['string', 'null'], maxLength: 80 }, evidence: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 1000 } },
    } } },
  },
} as const;

function requireString(value: unknown, label: string, maxLength: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) throw new Error(`Assistant response ${label} is invalid.`);
  return value;
}

function validateCitation(value: unknown, catalog: SourceCatalog, selection?: ContextSelection, decision = false): AssistantCitation {
  if (!value || typeof value !== 'object') throw new Error('Assistant returned an invalid citation.');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== (decision ? 'quote,revision,sourceId,sourceVersion,text' : 'quote,revision,sourceId,sourceVersion')) throw new Error('Assistant citation contains unsupported fields.');
  const sourceId = requireString(record.sourceId, 'citation source ID', 512, false);
  const source = catalog.byId.get(sourceId);
  if (!source || typeof record.revision !== 'number' || record.revision !== source.revision) throw new Error('Assistant citation refers to an unknown or stale source revision.');
  if (record.sourceVersion !== source.version) throw new Error('Assistant citation refers to a different source version.');
  const quote = requireString(record.quote, 'citation quote', 1000, false);
  const visible = selection ? selection.excerpts[sourceId] : source.text;
  if (!visible || !visible.includes(quote)) throw new Error('Assistant citation quote is not an exact quote from included source text.');
  return { sourceId, revision: source.revision, sourceVersion: source.version, quote, source: source.title ?? source.id };
}

/** Rejects fabricated, stale, omitted-context, or approximate evidence without asking the provider to repair it. */
export function validateAssistantResponse(value: unknown, catalog: SourceCatalog, selection?: ContextSelection, transcriptSourceId = 'transcript'): AssistantResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Assistant response must be an object.');
  const raw = value as Record<string, unknown>;
  const allowed = ['summary', 'answer', 'decisions', 'citations', 'clarifications', 'proposals'];
  if (Object.keys(raw).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in raw))) throw new Error('Assistant response does not match the required schema.');
  const summary = requireString(raw.summary, 'summary', 3000);
  const answer = requireString(raw.answer, 'answer', 6000);
  if (!Array.isArray(raw.citations) || raw.citations.length > 30 || !Array.isArray(raw.decisions) || raw.decisions.length > 20 || !Array.isArray(raw.clarifications) || raw.clarifications.length > 10 || !Array.isArray(raw.proposals) || raw.proposals.length > 20) throw new Error('Assistant response contains too many structured items.');
  const citations = raw.citations.map((citation) => validateCitation(citation, catalog, selection));
  const decisions: AssistantDecision[] = raw.decisions.map((decision) => {
    if (!decision || typeof decision !== 'object') throw new Error('Assistant returned an invalid decision.');
    const record = decision as Record<string, unknown>;
    const evidence = validateCitation(record, catalog, selection, true);
    return { text: requireString(record.text, 'decision', 1000, false), ...evidence };
  });
  const clarifications = raw.clarifications.map((item) => requireString(item, 'clarification', 1000));
  const transcript = catalog.byId.get(transcriptSourceId);
  const proposals: AssistantProposal[] = raw.proposals.map((proposal) => {
    if (!proposal || typeof proposal !== 'object') throw new Error('Assistant returned an invalid proposal.');
    const record = proposal as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'body,dueAt,evidence,kind,recipients,title') throw new Error('Assistant proposal contains unsupported fields.');
    const kinds = ['task', 'reminder', 'email', 'event', 'memory'];
    if (typeof record.kind !== 'string' || !kinds.includes(record.kind)) throw new Error('Assistant proposal has an invalid kind.');
    if (!Array.isArray(record.recipients) || record.recipients.length > 10 || record.recipients.some((item) => typeof item !== 'string' || item.length > 320 || /[\r\n\u0000]/.test(item))) throw new Error('Assistant proposal recipients are invalid.');
    if (record.dueAt !== null && (typeof record.dueAt !== 'string' || record.dueAt.length > 80 || !Number.isFinite(Date.parse(record.dueAt)))) throw new Error('Assistant proposal date is invalid.');
    if (!Array.isArray(record.evidence) || record.evidence.length < 1 || record.evidence.length > 5 || record.evidence.some((item) => typeof item !== 'string' || !item || item.length > 1000 || !transcript?.text.includes(item) || (selection && !selection.excerpts[transcriptSourceId]?.includes(item)))) throw new Error('Assistant proposal evidence is not an exact transcript quote.');
    return { kind: record.kind as AssistantProposal['kind'], title: requireString(record.title, 'proposal title', 140, false), body: requireString(record.body, 'proposal body', 2000), recipients: [...record.recipients] as string[], dueAt: record.dueAt as string | null, evidence: [...record.evidence] as string[] };
  });
  return { summary, answer, decisions, citations, clarifications, proposals };
}

function firstSentence(transcript: string): string {
  return transcript.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => sentence.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 1000);
}

type TaskCountKind = 'open' | 'completed' | 'total' | 'all';

function taskCountKind(question: string): TaskCountKind | undefined {
  const asksForCount = /\btask count\b/i.test(question) || (/\bhow many\b/i.test(question) && /\btasks?\b/i.test(question));
  if (!asksForCount || /\b(due|overdue|deadline|before|after|tomorrow|today|this week|next week)\b/i.test(question)) return undefined;
  if (/\b(open|active|incomplete|unfinished)\b[\s\S]*\btasks?\b|\btasks?\b[\s\S]*\b(open|active|incomplete|unfinished)\b/i.test(question)) return 'open';
  if (/\b(completed|complete|finished|done)\b[\s\S]*\btasks?\b|\btasks?\b[\s\S]*\b(completed|complete|finished|done)\b/i.test(question)) return 'completed';
  if (/\b(total|all)\b[\s\S]*\btasks?\b|\btasks?\b[\s\S]*\b(total|all)\b/i.test(question)) return 'total';
  return 'all';
}

function localDateFor(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function eventEpoch(start: string | undefined, timeZone: string | undefined): number | undefined {
  if (!start || start.length > 100) return undefined;
  const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(start);
  const utcNaive = timeZone?.toUpperCase() === 'UTC' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(start);
  if (!explicitZone && !utcNaive) return undefined;
  const timestamp = Date.parse(utcNaive ? `${start}Z` : start);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** A deterministic preview. It never queries a provider or invents external state. */
export function buildOfflinePreview(input: OfflinePreviewInput): AssistantResponse {
  const transcript = input.transcript.trim();
  const first = firstSentence(transcript);
  const summary = first ? `Offline preview: ${first}` : 'Offline preview: No transcript text is available yet.';
  const question = input.question?.trim() ?? '';
  let answer = 'AI is not connected. Your note is saved locally, and no external action was taken.';
  let clarifications: string[] = [];
  if (input.intent === 'summarize') answer = summary;
  else if (question && /\b(what did i say|what did i mention|quote|repeat|verbatim)\b/i.test(question)) {
    answer = first ? `From this note: “${first}”` : 'There is no transcript text to quote yet.';
  } else if (question && input.tasks && taskCountKind(question)) {
    const open = input.tasks.filter((task) => task.status === 'open').length;
    const completed = input.tasks.filter((task) => task.status === 'completed').length;
    const countKind = taskCountKind(question)!;
    if (countKind === 'open') answer = `The local task list has ${open} open task${open === 1 ? '' : 's'}.`;
    else if (countKind === 'completed') answer = `The local task list has ${completed} completed task${completed === 1 ? '' : 's'}.`;
    else if (countKind === 'total') answer = `The local task list has ${input.tasks.length} task${input.tasks.length === 1 ? '' : 's'} in total.`;
    else answer = `The local task list has ${open} open, ${completed} completed, and ${input.tasks.length} total task${input.tasks.length === 1 ? '' : 's'}.`;
  } else if (question && /\b(upcoming|next|tomorrow|today|calendar|meeting)\b/i.test(question)
    && !(/\btasks?\b/i.test(question) && /\b(due|overdue|deadline|before|after|tomorrow|today|this week|next week)\b/i.test(question))) {
    const now = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);
    let validZone = true;
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(0); } catch { validZone = false; }
    if (input.calendarSnapshotAvailable !== true || !input.calendarEvents || !validZone || !Number.isFinite(now)) {
      answer = 'I can’t verify current calendar events from this local snapshot.';
      clarifications = ['Sync a calendar and use a valid time zone before asking about upcoming events.'];
    } else {
      const today = localDateFor(now, input.timeZone);
      const targetDate = /\btomorrow\b/i.test(question) ? shiftCalendarDate(today, 1) : /\btoday\b/i.test(question) ? today : undefined;
      const available = input.calendarEvents.flatMap((event) => {
        const start = eventEpoch(event.start, event.timeZone);
        if (start === undefined || start < now || (targetDate && localDateFor(start, input.timeZone) !== targetDate)) return [];
        return [{ event, start }];
      }).sort((a, b) => a.start - b.start).slice(0, 3);
      if (available.length) {
        const formatter = new Intl.DateTimeFormat('en', { timeZone: input.timeZone, dateStyle: 'medium', timeStyle: 'short' });
        answer = `From the local calendar snapshot: ${available.map(({ event, start }) => `${event.subject || 'Untitled event'} at ${formatter.format(start)}`).join('; ')}.`;
      } else if (input.calendarEvents.every((event) => eventEpoch(event.start, event.timeZone) !== undefined)) {
        answer = targetDate ? `No upcoming events were found for ${targetDate} in the local calendar snapshot.` : 'No upcoming events were found in the local calendar snapshot.';
      } else {
        answer = 'I can’t verify the calendar times because some events lack an explicit time zone.';
        clarifications = ['Sync events with explicit time-zone data before asking about their dates.'];
      }
    }
  } else if (question && /\b(task|tasks|upcoming|next|tomorrow|today|calendar|meeting)\b/i.test(question)) {
    answer = 'I can’t verify current tasks or calendar events from this local snapshot.';
    clarifications = ['Sync the relevant account or add the details you want me to check.'];
  }
  const decisionMatch = transcript.match(/\bI decided\s+[^.!?\n]+[.!?]?/);
  const decisionQuote = decisionMatch?.[0];
  const decisionText = decisionQuote?.replace(/^\s*I decided\s*/i, '').replace(/[.!?]+$/, '').trim();
  const sourceVersion = input.transcriptSourceVersion;
  const revision = input.transcriptRevision;
  const decisions = decisionQuote && decisionText && Number.isSafeInteger(revision) && revision! >= 0 && typeof sourceVersion === 'string' && sourceVersion.length <= 320
    ? [{ text: decisionText, sourceId: 'transcript', revision: revision!, sourceVersion, quote: decisionQuote, source: 'Transcript' }]
    : [];
  return { summary, answer, decisions, citations: decisions.map(({ sourceId, revision, sourceVersion, quote, source }) => ({ sourceId, revision, sourceVersion, quote, source })), clarifications, proposals: [] };
}
