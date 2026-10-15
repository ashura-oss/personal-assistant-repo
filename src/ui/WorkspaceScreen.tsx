import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import { Button, IconButton } from './primitives';
import { C, s } from './theme';

export type WorkspaceTab = 'inbox' | 'record' | 'chat' | 'library';

/** Safe display inputs shared by the native and server-owned workspace shells. */
export type WorkspaceScreenModel = Readonly<{
  activeTab: WorkspaceTab;
  busy: boolean;
  tabBarVisible: boolean;
  tabNavigationLocked: boolean;
  notice?: string;
  snapshot?: WorkspaceSnapshotDTO;
}>;

export type WorkspaceScreenActions = Readonly<{
  navigation: Readonly<{ selectTab: (tab: WorkspaceTab) => void }>;
  settings?: Readonly<{ open: () => void }>;
  session?: Readonly<{ logout: () => void }>;
}>;

export function WorkspaceScreen({ model, actions, children }: {
  model: WorkspaceScreenModel;
  actions: WorkspaceScreenActions;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <View style={s.viewport}>
          <View style={s.header}>
            <View>
              <Text style={s.wordmark}>still</Text>
              <Text style={s.headerHint}>A quieter way to keep up</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {actions.settings ? <IconButton name="settings-outline" label="Open settings" onPress={actions.settings.open} /> : null}
              {actions.session ? <Button label="Sign out" tone="quiet" disabled={model.busy} onPress={actions.session.logout} /> : null}
            </View>
          </View>
          {children}
          {model.tabBarVisible ? (
            <View style={s.tabBar} accessibilityRole="tablist">
              {(['inbox', 'record', 'chat', 'library'] as const).map((tab) => (
                <Pressable
                  key={tab}
                  accessibilityRole="tab"
                  accessibilityLabel={`${tab[0]!.toUpperCase()}${tab.slice(1)} tab`}
                  accessibilityState={{ selected: model.activeTab === tab }}
                  disabled={model.busy || model.tabNavigationLocked}
                  onPress={() => { if (!model.busy && !model.tabNavigationLocked) actions.navigation.selectTab(tab); }}
                  style={s.tab}
                >
                  <Ionicons accessible={false} importantForAccessibility="no" name={tab === 'inbox' ? 'file-tray-outline' : tab === 'record' ? 'mic-outline' : tab === 'chat' ? 'chatbubble-outline' : 'book-outline'} size={19} color={model.activeTab === tab ? C.text : C.muted} />
                  <Text style={[s.tabLabel, model.activeTab === tab && s.tabSelected]}>{tab[0]!.toUpperCase()}{tab.slice(1)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
