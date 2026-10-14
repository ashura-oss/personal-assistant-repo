import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { KnowledgeEntityDisplay, KnowledgePersonDisplay, KnowledgeProjectDisplay } from './knowledgeDisplayTypes';
import { Button } from './primitives';
import { s } from './theme';

type PersonDisplay = KnowledgePersonDisplay;
type ProjectDisplay = KnowledgeProjectDisplay;
type Props = {
  kind: 'person' | 'project';
  people: readonly PersonDisplay[];
  projects: readonly ProjectDisplay[];
  query: string;
  busy: boolean;
  onCreate: () => void;
  onOpen: (entity: KnowledgeEntityDisplay) => void;
  onArchive: (kind: 'person' | 'project', id: string, revision: number, archived: boolean) => void;
};

export function KnowledgeSection({ kind, people, projects, query, busy, onCreate, onOpen, onArchive }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entities = useMemo(() => {
    const source = kind === 'person' ? people : projects;
    return source.filter((entity) => {
      if (Boolean(entity.archivedAt) !== showArchived) return false;
      return !normalizedQuery || [entity.name, ...entity.aliases,
        ...('goal' in entity ? [entity.goal, entity.status] : []),
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [kind, people, projects, showArchived, normalizedQuery]);

  return (
    <View style={{ gap: 12 }}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>{kind === 'person' ? 'People' : 'Projects'}</Text>
        <Button label={kind === 'person' ? 'Add person' : 'Add project'} onPress={onCreate} disabled={busy} tone="quiet" icon="add" />
      </View>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: showArchived }} onPress={() => setShowArchived((value) => !value)} style={s.knowledgeArchiveToggle}>
        <Text style={s.knowledgeFilterText}>{showArchived ? 'Showing archived' : 'Show archived'}</Text>
      </Pressable>
      {entities.length ? entities.map((entity) => {
        return (
          <View key={`${kind}:${entity.id}`} style={s.knowledgeCard}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${kind} ${entity.name}`} onPress={() => onOpen(entity)} style={{ flex: 1, minHeight: 56, justifyContent: 'center', gap: 4 }}>
              <Text style={s.knowledgeName}>{entity.name}</Text>
              <Text style={s.knowledgeMeta} numberOfLines={2}>
                {'goal' in entity ? `${entity.status} · ${entity.goal || 'No goal added'}` : entity.aliases.length ? `Also known as ${entity.aliases.join(', ')}` : `${entity.facts.length} saved facts · ${'contacts' in entity ? entity.contacts.length : 0} contact claims`}
                {entity.archivedAt ? ' · Archived' : ''}
              </Text>
              {entity.importOrigin?.kind === 'backup_knowledge' ? <Text style={s.knowledgeFootnote}>Imported separate copy</Text> : null}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={entity.archivedAt ? `Reopen ${kind} ${entity.name}` : `Archive ${kind} ${entity.name}`} disabled={busy} onPress={() => onArchive(kind, entity.id, entity.revision, !entity.archivedAt)} style={s.knowledgeSmallAction}>
              <Text style={s.knowledgeActionText}>{entity.archivedAt ? 'Reopen' : 'Archive'}</Text>
            </Pressable>
          </View>
        );
      }) : (
        <View style={s.knowledgeEmpty}>
          <Text style={s.emptyTitle}>{normalizedQuery ? `No ${kind === 'person' ? 'people' : 'projects'} found` : showArchived ? `No archived ${kind === 'person' ? 'people' : 'projects'}` : `No ${kind === 'person' ? 'people' : 'projects'} yet`}</Text>
          <Text style={s.emptyText}>{normalizedQuery ? 'Try a different search.' : kind === 'person' ? 'Keep useful details about people you know. You decide what to save.' : 'Keep project goals, dates, and members together.'}</Text>
        </View>
      )}
      <Text style={s.knowledgeFootnote}>Saved context stays editable. Contact details are claims, not verified identities.</Text>
    </View>
  );
}
