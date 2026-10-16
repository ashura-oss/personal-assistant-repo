import test from 'node:test';
import { verifyLocalHttpReminderUnavailable } from './fixtures/localHttpReminderHost.mjs';

test('localhost HTTP keeps workspace service available and rejects server reminders before persistence', async () => {
  await verifyLocalHttpReminderUnavailable('localhost');
});
