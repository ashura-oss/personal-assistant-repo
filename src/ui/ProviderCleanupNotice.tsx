import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import type { ProviderCleanupItem, ProviderCleanupRegistry, ProviderPurpose } from '../services/providerResponseLifetime';
import { Button } from './primitives';
import { s } from './theme';

const PURPOSE_LABELS: Record<ProviderPurpose, string> = {
  connector: 'mail or calendar connection',
  oauth: 'sign-in request',
  azure_ai: 'assistant request',
  azure_speech: 'speech request',
  openrouter_batch: 'Batch request',
  openrouter_speech: 'speech request',
};

export function visibleProviderCleanupItems(items: readonly ProviderCleanupItem[], scope: 'workspace' | 'all'): ProviderCleanupItem[] {
  // Keep every safe process entry reachable from the active workspace. A domain
  // replacement may leave an older-purpose request alive in the process registry.
  void scope;
  return [...items];
}

export function ProviderCleanupNotice({ registry, scope = 'all' }: {
  registry: ProviderCleanupRegistry;
  scope?: 'workspace' | 'all';
}) {
  const pendingSnapshot = useRef<readonly ProviderCleanupItem[] | undefined>(undefined);
  const getSnapshot = useCallback(() => {
    const latest = registry.getPending();
    const previous = pendingSnapshot.current;
    if (previous && previous.length === latest.length && previous.every((item, index) => item.id === latest[index]?.id && item.purpose === latest[index]?.purpose)) return previous;
    pendingSnapshot.current = latest;
    return latest;
  }, [registry]);
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const pending = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  const retrying = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const items = visibleProviderCleanupItems(pending, scope);
  if (!items.length) return null;

  const retry = async (id: string) => {
    if (retrying.current.has(id)) return;
    retrying.current.add(id);
    setRetryingIds(new Set(retrying.current));
    try {
      await registry.retryCancellation(id);
    } catch {
      // The pending safe purpose row remains; retry never starts a new request.
    } finally {
      retrying.current.delete(id);
      if (mounted.current) setRetryingIds(new Set(retrying.current));
    }
  };

  return (
    <View accessibilityLabel="Pending native request cancellation" style={[s.notice, { flexDirection: 'column', alignItems: 'stretch' }]}>
      <Text style={[s.noticeText, { fontWeight: '600' }]}>A provider request is still closing ({items.length}).</Text>
      {items.map((item) => (
        <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[s.noticeText, { flex: 1 }]}>{PURPOSE_LABELS[item.purpose]}</Text>
          <Button
            label={retryingIds.has(item.id) ? 'Retrying cancellation…' : 'Retry cancellation'}
            tone="quiet"
            disabled={retryingIds.has(item.id)}
            onPress={() => { void retry(item.id); }}
          />
        </View>
      ))}
    </View>
  );
}
