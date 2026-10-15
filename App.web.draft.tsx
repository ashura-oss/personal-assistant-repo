import React from 'react';
import { AuthGate } from './src/web/AuthGate';
import { CloudWorkspaceSession } from './src/web/CloudWorkspaceSession';

export default function AppWeb() {
  return <AuthGate renderWorkspace={(session, onLogout) => (
    <CloudWorkspaceSession
      key={`${session.workspaceId}:${session.privacyEpoch}:${session.csrfToken}`}
      session={session}
      onLogout={onLogout}
    />
  )} />;
}
