import { afterEach, describe, expect, it, vi } from 'vitest';

describe('isolated privacy cleanup preview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_PREVIEW_SCENARIO;
    delete process.env.EXPO_PUBLIC_PREVIEW_PRIVACY_CASE;
  });

  async function fixtureFor(fault?: string) {
    vi.stubGlobal('__DEV__', true);
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO = 'privacy-cleanup';
    if (fault) process.env.EXPO_PUBLIC_PREVIEW_PRIVACY_CASE = fault;
    const { createPrivacyCleanupPreview } = await import('../src/dev/privacyPreview');
    return createPrivacyCleanupPreview();
  }

  it('runs the real engine to a verified complete status over memory-only targets', async () => {
    const { privacy, session, controller, readPersistedState, openFreshWorkspace } = await fixtureFor();
    expect((await privacy.getStatus()).phase).toBe('ready');
    await controller.load();
    expect(controller.getSnapshot().notes).toHaveLength(2);
    expect(controller.getSnapshot().tasks).toHaveLength(1);
    expect(controller.getSnapshot().documents.some((doc) => doc.path === 'memory/RULES.md')).toBe(true);
    const plan = await privacy.prepareErase();
    expect(plan.targetCount).toBe(12);
    await privacy.cancelErase(plan.sessionId);
    expect((await readPersistedState())?.notes).toHaveLength(2);
    const confirmedPlan = await privacy.prepareErase();
    await privacy.commitErase({ sessionId: confirmedPlan.sessionId, planHash: confirmedPlan.planHash });
    let status = await privacy.getStatus();
    while (status.phase === 'erasing') {
      await privacy.runCleanupPass();
      status = await privacy.getStatus();
    }
    expect(status.phase).toBe('complete');
    expect(await readPersistedState()).toBeUndefined();
    await expect(privacy.assertWorkspaceEpoch(session.epoch)).rejects.toThrow();
    await expect(controller.saveNote({ transcript: 'Must not write after erase.' })).rejects.toThrow();
    const fresh = await openFreshWorkspace();
    await fresh.controller.load();
    expect(fresh.controller.getSnapshot().notes).toHaveLength(0);
    expect(fresh.controller.getSnapshot().tasks).toHaveLength(0);
    expect(fresh.controller.getSnapshot().documents.some((doc) => doc.content.includes('Fictional local preview data.'))).toBe(false);
  });

  it('starts paused when a durable cleanup journal was already paused before app mount', async () => {
    const { privacy, readPersistedState } = await fixtureFor('paused-startup');
    expect((await privacy.getStatus()).phase).toBe('paused');
    expect((await readPersistedState())?.notes).toHaveLength(2);
    await privacy.runCleanupPass();
    expect((await privacy.getStatus()).phase).toBe('complete');
    expect(await readPersistedState()).toBeUndefined();
  });

  it('recovers a lost post-commit status read without recommitting', async () => {
    const { privacy, controller, readPersistedState } = await fixtureFor('unknown-confirm-status');
    await controller.load();
    const plan = await privacy.prepareErase();
    await expect(privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash })).rejects.toThrow('lost after commit');
    await expect(privacy.getStatus()).rejects.toThrow('lost');
    expect((await privacy.getStatus()).phase).toBe('erasing');
    for (let pass = 0; pass < 4; pass += 1) await privacy.runCleanupPass();
    expect((await privacy.getStatus()).phase).toBe('complete');
    expect(await readPersistedState()).toBeUndefined();
  });

  it('pauses on a failed local step and completes only after explicit retry', async () => {
    const { privacy } = await fixtureFor('failed-step');
    const plan = await privacy.prepareErase();
    await privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    const first = await privacy.runCleanupPass();
    expect(first.phase).toBe('paused');
    expect((await privacy.getStatus()).phase).toBe('paused');
    const retry = await privacy.runCleanupPass();
    expect(retry.phase).toBe('complete');
    expect((await privacy.getStatus()).phase).toBe('complete');
  });

  it('keeps a lost confirmation response recoverable without committing twice', async () => {
    const { privacy } = await fixtureFor('lost-confirm');
    const plan = await privacy.prepareErase();
    await expect(privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash })).rejects.toThrow();
    expect((await privacy.getStatus()).phase).toBe('erasing');
    for (let pass = 0; pass < 4; pass += 1) await privacy.runCleanupPass();
    expect((await privacy.getStatus()).phase).toBe('complete');
  });
});
