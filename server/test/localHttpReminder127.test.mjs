import test from 'node:test';
import { verifyLocalHttpReminderUnavailable } from './fixtures/localHttpReminderHost.mjs';

test('127.0.0.1 HTTP keeps workspace service available and rejects server reminders before persistence', async () => {
  await verifyLocalHttpReminderUnavailable('127.0.0.1');
});
