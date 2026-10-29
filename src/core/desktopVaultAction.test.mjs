import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopVaultAction } from './desktopVaultAction.ts';

test('a refused system trash does not cancel the vault operation', async () => {
  const calls = [];
  const result = await desktopVaultAction(
    async () => { calls.push('vault committed'); },
    async () => { calls.push('system refused'); throw new Error('portal refused'); },
    () => calls.push('diagnostic only'),
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, ['vault committed', 'system refused', 'diagnostic only']);
});

test('a failed vault operation leaves the local original untouched', async () => {
  let attempted = false;
  await assert.rejects(desktopVaultAction(
    async () => { throw new Error('permission denied'); },
    async () => { attempted = true; },
    () => {},
  ), /permission denied/);
  assert.equal(attempted, false);
});

test('successful desktop integration is retained', async () => {
  assert.equal(await desktopVaultAction(async () => {}, async () => 1, () => assert.fail()), 1);
});
