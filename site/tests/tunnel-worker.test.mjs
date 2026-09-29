import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../static/tunnel/sw.js', import.meta.url), 'utf8');

test('registering a host reclaims hard-reloaded pages before acknowledging readiness', async () => {
  const handlers = {};
  const replies = [];
  let finishClaim;
  let claims = 0;
  const self = {
    addEventListener(type, handler) { handlers[type] = handler; },
    clients: {
      claim() {
        claims++;
        return new Promise(resolve => { finishClaim = resolve; });
      },
    },
  };
  vm.runInNewContext(source, { self });
  for (let attempt = 0; attempt < 2; attempt++) {
    let lifetime;
    handlers.message({
      data: { type: 'register-owner' },
      source: { id: 'host', postMessage(message) { replies.push(message.type); } },
      waitUntil(promise) { lifetime = promise; },
    });
    assert.equal(claims, attempt + 1);
    assert.equal(replies.length, attempt);
    finishClaim();
    await lifetime;
    assert.equal(replies.at(-1), 'owner-registered');
  }
});
