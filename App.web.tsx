import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthGate } from './src/web/AuthGate';
import { CloudWorkspaceSession } from './src/web/CloudWorkspaceSession';

export default function AppWeb() {
  return (
    <SafeAreaProvider>
      <AuthGate renderWorkspace={(session, onLogout, onRecheckSession) => (
        <CloudWorkspaceSession
          key={`${session.workspaceId}:${session.privacyEpoch}:${session.csrfToken}`}
          session={session}
          onLogout={onLogout}
          onRecheckSession={onRecheckSession}
        />
      )} />
    </SafeAreaProvider>
  );
}
