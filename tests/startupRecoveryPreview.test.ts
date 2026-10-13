import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return { ...actual, Platform: { ...actual.Platform, OS: 'web' } };
});

async function createPreview() {
  const { createStartupRecoveryPreview } = await import('../src/dev/startupRecoveryPreview');
  return createStartupRecoveryPreview();
}

describe('isolated startup recovery preview', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', true);
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO = 'startup-recovery';
    delete process.env.EXPO_PUBLIC_PREVIEW_RECOVERY_CASE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_PREVIEW_SCENARIO;
    delete process.env.EXPO_PUBLIC_PREVIEW_RECOVERY_CASE;
  });

  it('keeps the same corrupt snapshot unreadable after retry and cancel, then opens the real helper replacement', async () => {
    const app = await createPreview();
    await expect(app.load()).rejects.toThrow(/fictional saved snapshot/i);
    expect(await app.getStartupRecoveryStatus()).toMatchObject({ phase: 'failed', inspection: { status: 'available', archiveCount: 0 } });
    await expect(app.retryStartup()).rejects.toThrow();

    const abandoned = await app.prepareStartupRecovery();
    await app.cancelStartupRecovery();
    expect(await app.getStartupRecoveryStatus()).toMatchObject({ phase: 'failed', inspection: { archiveCount: 0 } });
    await expect(app.retryStartup()).rejects.toThrow();

    const plan = await app.prepareStartupRecovery();
    expect(plan.sessionId).not.toBe(abandoned.sessionId);
    await app.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash });
    expect(await app.getStartupRecoveryStatus()).toMatchObject({ phase: 'ready' });
    expect(app.getSnapshot().notes).toEqual([]);
  });

  it('rolls back a failed archive transaction and leaves the source corrupt', async () => {
    process.env.EXPO_PUBLIC_PREVIEW_RECOVERY_CASE = 'archive-failure';
    const app = await createPreview();
    await expect(app.load()).rejects.toThrow();
    const plan = await app.prepareStartupRecovery();
    await expect(app.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash })).rejects.toThrow(/archive write failure/i);
    expect(await app.getStartupRecoveryStatus()).toMatchObject({ phase: 'prepared', inspection: { archiveCount: 0 } });
    await app.cancelStartupRecovery();
    await expect(app.retryStartup()).rejects.toThrow(/fictional saved snapshot/i);
  });

  it('retains the receipt across one post-commit open failure and does not archive a second time', async () => {
    process.env.EXPO_PUBLIC_PREVIEW_RECOVERY_CASE = 'post-commit-failure';
    const app = await createPreview();
    await expect(app.load()).rejects.toThrow();
    const plan = await app.prepareStartupRecovery();
    await app.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash });
    expect(await app.getStartupRecoveryStatus()).toMatchObject({
      phase: 'committed_opening',
      inspection: { archiveCount: 1, pendingReceipt: { evidenceBytes: expect.any(Number) } },
    });
    await app.retryStartup();
    expect(await app.getStartupRecoveryStatus()).toMatchObject({ phase: 'ready' });
    await expect(app.retryStartup()).rejects.toThrow();
  });
});
