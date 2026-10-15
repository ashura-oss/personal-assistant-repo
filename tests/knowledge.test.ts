import { describe, expect, it } from 'vitest';
import { emptyKnowledgeState, knowledgeContextSources, renderKnowledgeMarkdown, validateKnowledgeState } from '../src/knowledge';

const at = '2026-10-12T10:00:00.000Z';
const personId = '123e4567-e89b-42d3-a456-426614174000';
const projectId = '123e4567-e89b-42d3-a456-426614174001';
const factId = '123e4567-e89b-42d3-a456-426614174002';
const suggestionId = '123e4567-e89b-42d3-a456-426614174003';
const digest = 'a'.repeat(64);

function sample() {
  return {
    schemaVersion: 1,
    people: [{ id: personId, revision: 1, name: 'Ada', aliases: ['A.'], narrativePath: `people/${personId}.md`, createdAt: at, updatedAt: at,
      facts: [{ id: factId, provenance: 'accepted_inference', createdAt: at, evidence: [{ sourceId: 'note-1', sourceVersion: `2:${digest}`, revision: 2, quote: 'Works on robotics' }], statement: 'Works on robotics' }],
      contacts: [{ id: '123e4567-e89b-42d3-a456-426614174004', provenance: 'user_authored', createdAt: at, address: 'ada@example.test', label: 'Email' }],
      sourceLinks: [{ id: '123e4567-e89b-42d3-a456-426614174006', provenance: 'user_authored', createdAt: at, reference: { kind: 'mail', id: 'message-1', identityKey: 'google:me', connectionGeneration: 3 }, label: 'Planning email' }] }],
    projects: [{ id: projectId, revision: 1, name: 'Robot', aliases: [], narrativePath: `projects/${projectId}.md`, createdAt: at, updatedAt: at,
      status: 'active', goal: 'Build a small robot', startsOn: '2026-10-01', dateTimeZone: 'Asia/Singapore', facts: [], sourceLinks: [],
      members: [{ id: '123e4567-e89b-42d3-a456-426614174005', provenance: 'user_authored', createdAt: at, personId, role: 'Lead' }] }],
    suggestions: [{ id: suggestionId, revision: 1, change: { type: 'add_fact', entityKind: 'person', entityId: personId, statement: 'Works on robotics' },
      targetRevision: 1, evidence: [{ sourceId: 'note-1', sourceVersion: `2:${digest}`, revision: 2, quote: 'Works on robotics' }], status: 'pending', createdAt: at, updatedAt: at }],
  };
}

describe('knowledge schema', () => {
  it('normalizes strict structured state and renders summaries from claims', () => {
    const state = validateKnowledgeState(sample());
    expect(state.people[0]?.sourceLinks[0]).toMatchObject({ reference: { kind: 'mail', identityKey: 'google:me', connectionGeneration: 3 } });
    expect(renderKnowledgeMarkdown(state, 'person', personId)).toContain('Works on robotics');
    expect(renderKnowledgeMarkdown(state, 'project', projectId)).toContain('Lead: Ada');
    expect(emptyKnowledgeState()).toEqual({ schemaVersion: 1, people: [], projects: [], suggestions: [] });
  });

  it('rejects unsafe narrative paths, invalid dates, missing references, and unknown fields', () => {
    const value = sample();
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], narrativePath: 'people/Ada.md' }] })).toThrow(/narrative path/i);
    expect(() => validateKnowledgeState({ ...value, projects: [{ ...value.projects[0], startsOn: '2026-02-30' }] })).toThrow(/start date/i);
    expect(() => validateKnowledgeState({ ...value, projects: [{ ...value.projects[0], members: [{ ...value.projects[0].members[0], personId: projectId }] }] })).toThrow(/missing person/i);
    expect(() => validateKnowledgeState({ ...value, runtimeToken: 'secret' })).toThrow(/unsupported field/i);
  });

  it('rejects malformed provenance, unresolved active targets, and overlong evidence', () => {
    const value = sample();
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: [{ ...value.people[0].facts[0], provenance: 'inferred' }] }] })).toThrow(/provenance/i);
    expect(() => validateKnowledgeState({ ...value, suggestions: [{ ...value.suggestions[0], change: { ...value.suggestions[0].change, entityId: '123e4567-e89b-42d3-a456-426614174099' } }] })).toThrow(/missing entity/i);
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: [{ ...value.people[0].facts[0], evidence: [{ sourceId: 'note', sourceVersion: `1:${digest}`, revision: 1, quote: 'é'.repeat(600) }] }] }] })).toThrow(/quote/i);
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: [{ ...value.people[0].facts[0], evidence: [{ sourceId: 'note', sourceVersion: `2:${digest}`, revision: 2, quote: ' \n\t' }] }] }] })).toThrow(/blank/i);
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: [{ ...value.people[0].facts[0], evidence: undefined }] }] })).toThrow(/requires evidence/i);
    expect(() => validateKnowledgeState({ ...value, suggestions: [{ ...value.suggestions[0], change: { type: 'add_fact', entityKind: 'person', entityId: projectId, statement: 'Wrong target kind' } }] })).toThrow(/entity kind/i);
    expect(() => validateKnowledgeState({ ...value, suggestions: [{ ...value.suggestions[0], change: { type: 'add_member', entityKind: 'project', entityId: projectId, personId: '123e4567-e89b-42d3-a456-426614174099', personRevision: 1, role: 'Lead' } }] })).toThrow(/missing person/i);
  });

  it('uses only canonical narrative paths and includes archived context only when selected', () => {
    const value = sample();
    const state = validateKnowledgeState({ ...value, people: [{ ...value.people[0], archivedAt: at }] });
    const path = `people/${personId}.md`;
    expect(knowledgeContextSources(state, [{ path: 'people/Ada.md', content: 'Wrong narrative' }])).toHaveLength(1);
    const selected = knowledgeContextSources(state, [{ path, content: 'Canonical narrative' }], [{ kind: 'person', id: personId }]);
    expect(selected[0]).toMatchObject({ id: `knowledge:person:${personId}`, kind: 'knowledge', title: 'Ada', required: false });
    expect(selected[0]?.text).toContain('Status: archived');
    expect(selected[0]?.text).toContain('Canonical narrative');
  });

  it('labels historical sources and imported claims as unavailable and unverified', () => {
    const value = sample();
    const person = { ...value.people[0], importOrigin: { kind: 'backup_knowledge', archiveId: '123e4567-e89b-42d3-a456-426614174007', cohortId: '123e4567-e89b-42d3-a456-426614174008', sourceEntityId: personId, sourceDigest: digest },
      sourceLinks: [{ id: '123e4567-e89b-42d3-a456-426614174010', provenance: 'user_authored', createdAt: at, reference: { kind: 'historical', label: 'Old calendar item', originalKind: 'calendar' }, label: 'Old calendar item' }] };
    const project = { ...value.projects[0], members: [{ id: '123e4567-e89b-42d3-a456-426614174011', provenance: 'accepted_inference', createdAt: at, sourcePersonId: personId, label: 'Ada', role: 'Lead', evidence: [{ sourceId: 'note', sourceVersion: `2:${digest}`, revision: 2, quote: 'Ada leads' }] }] };
    const state = validateKnowledgeState({ ...value, people: [person], projects: [project] });
    const personText = renderKnowledgeMarkdown(state, 'person', personId);
    const projectText = renderKnowledgeMarkdown(state, 'project', projectId);
    expect(personText).toContain('imported from a backup; unverified');
    expect(personText).toContain('historical calendar; unavailable');
    expect(personText).toContain('User-retained inference; unverified');
    expect(projectText).toContain('Historical member (unavailable)');
  });

  it('keeps valid oversized claims readable through honest omissions and fingerprints hidden edits', () => {
    const value = sample();
    const facts = Array.from({ length: 64 }, (_, index) => ({ id: `123e4567-e89b-42d3-a456-${String(index + 100).padStart(12, '0')}`,
      provenance: 'user_authored' as const, createdAt: at, statement: `claim-${index} ${'x'.repeat(1_000 - String(index).length - 1)}` }));
    const state = validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts }] });
    const source = knowledgeContextSources(state)[0]!;
    expect(new TextEncoder().encode(source.text).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(source.text).toContain('Omitted');
    const changed = validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: facts.map((fact, index) => index === 63 ? { ...fact, statement: `changed-${fact.statement}` } : fact) }] });
    expect(knowledgeContextSources(changed)[0]?.versionMaterial).not.toBe(source.versionMaterial);
  });

  it('roundtrips policy-2 knowledge counts, labels, evidence, and narrative content without relaxing legacy rows', () => {
    const value = sample();
    const longText = 'é'.repeat(1_200);
    const facts = Array.from({ length: 70 }, (_, index) => ({ id: `123e4567-e89b-42d3-a456-${String(index + 1000).padStart(12, '0')}`,
      provenance: 'accepted_inference' as const, createdAt: at, outputPolicyVersion: 2 as const,
      evidence: Array.from({ length: 5 }, (_, itemIndex) => ({ sourceId: `note-${itemIndex}`, sourceVersion: `2:${digest}`, revision: 2, quote: longText })),
      statement: `${index} ${longText}` }));
    const suggestions = Array.from({ length: 205 }, (_, index) => ({ id: `123e4567-e89b-42d3-a456-${String(index + 5000).padStart(12, '0')}`,
      revision: 1, change: { type: 'add_fact' as const, entityKind: 'person' as const, entityId: personId, statement: `${index} ${longText}` },
      targetRevision: 1, evidence: Array.from({ length: 5 }, (_, itemIndex) => ({ sourceId: `note-${itemIndex}`, sourceVersion: `2:${digest}`, revision: 2, quote: longText })),
      status: 'pending' as const, createdAt: at, updatedAt: at, outputPolicyVersion: 2 as const }));
    const state = validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts, contacts: value.people[0]!.contacts,
      sourceLinks: [{ ...value.people[0]!.sourceLinks[0], outputPolicyVersion: 2, label: longText }] }], suggestions });
    expect(state.people[0]?.facts).toHaveLength(70);
    expect(state.suggestions).toHaveLength(205);
    expect(state.people[0]?.sourceLinks[0]?.label).toBe(longText);
    expect(state.people[0]?.facts[0]?.evidence).toHaveLength(5);
    expect(renderKnowledgeMarkdown(state, 'person', personId).length).toBeGreaterThan(16 * 1024);
    expect(() => validateKnowledgeState({ ...value, suggestions: [{ ...value.suggestions[0], status: ['pending'] }] })).toThrow(/status/i);
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], contacts: [{ ...value.people[0]!.contacts[0], outputPolicyVersion: 2, address: 'a'.repeat(513) }] }] })).toThrow(/contact address/i);

    const legacyFacts = Array.from({ length: 65 }, (_, index) => ({ id: `123e4567-e89b-42d3-a456-${String(index + 1000).padStart(12, '0')}`,
      provenance: 'accepted_inference' as const, createdAt: at, evidence: [{ sourceId: 'note', sourceVersion: `2:${digest}`, revision: 2, quote: 'short quote' }], statement: `legacy ${index}` }));
    expect(() => validateKnowledgeState({ ...value, people: [{ ...value.people[0], facts: legacyFacts }] })).toThrow(/legacy facts/i);
  });

  it('fingerprints one-hop member and entity-link labels, and exposes project aliases and dates', () => {
    const value = sample();
    value.projects[0]!.aliases = ['Atlas'] as never[];
    Object.assign(value.projects[0]!, { targetOn: '2026-12-01' });
    const state = validateKnowledgeState(value);
    const projectSource = knowledgeContextSources(state).find((source) => source.id === `knowledge:project:${projectId}`)!;
    expect(projectSource.text).toContain('Aliases: Atlas');
    expect(projectSource.text).toContain('Target: 2026-12-01 (Asia/Singapore)');

    const renamed = validateKnowledgeState({ ...value, people: [{ ...value.people[0]!, name: 'Ada Lovelace' }] });
    expect(knowledgeContextSources(renamed).find((source) => source.id === projectSource.id)?.versionMaterial).not.toBe(projectSource.versionMaterial);
    const archived = validateKnowledgeState({ ...value, people: [{ ...value.people[0]!, archivedAt: at }] });
    expect(knowledgeContextSources(archived).find((source) => source.id === projectSource.id)?.versionMaterial).not.toBe(projectSource.versionMaterial);

    const linked = validateKnowledgeState({ ...value, projects: [{ ...value.projects[0]!, sourceLinks: [{
      id: '123e4567-e89b-42d3-a456-426614174012', provenance: 'user_authored', createdAt: at,
      reference: { kind: 'person', id: personId }, label: 'Owner',
    }] }] });
    const linkedSource = knowledgeContextSources(linked).find((source) => source.id === `knowledge:project:${projectId}`)!;
    const renamedLinked = validateKnowledgeState({ ...linked, people: [{ ...linked.people[0]!, name: 'Ada L.' }] });
    expect(knowledgeContextSources(renamedLinked).find((source) => source.id === linkedSource.id)?.versionMaterial).not.toBe(linkedSource.versionMaterial);
  });

  it('migrates pending legacy calendar links without a calendar ID to stale historical evidence', () => {
    const value = structuredClone(sample());
    Object.assign(value.people[0]!, { sourceLinks: [{ id: '123e4567-e89b-42d3-a456-426614174013', provenance: 'user_authored', createdAt: at,
      reference: { kind: 'calendar', id: 'same-event', identityKey: 'google:me', connectionGeneration: 1 }, label: 'Old meeting' }] });
    Object.assign(value.suggestions[0]!, { change: { type: 'add_source_link', entityKind: 'person', entityId: personId,
      reference: { kind: 'calendar', id: 'same-event', identityKey: 'google:me', connectionGeneration: 1 }, label: 'Old meeting' },
    });
    const normalized = validateKnowledgeState(value);
    expect(normalized.people[0]?.sourceLinks[0]?.reference).toMatchObject({ kind: 'historical', originalKind: 'calendar' });
    expect(normalized.suggestions[0]).toMatchObject({ status: 'stale', staleReason: expect.stringMatching(/calendar/i) });
    expect(normalized.suggestions[0]?.change).toMatchObject({ reference: { kind: 'historical', originalKind: 'calendar' } });
  });
});
