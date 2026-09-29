import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../static/tunnel/device/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function runFallback(tunnel, standalone = false) {
  const writes = [];
  const message = { textContent: '', append(link) { this.link = link; } };
  const window = { parent: { __espargosTunnel: tunnel } };
  if (standalone) window.parent = window;
  const document = {
    open() { writes.push('open'); },
    write(text) { writes.push(text); },
    close() { writes.push('close'); },
    getElementById() { return message; },
    createElement() { return {}; },
  };
  await vm.runInNewContext(script, { window, document });
  return { writes, message };
}

test('consecutive fallback navigations reuse the connected parent without a reload loop', async () => {
  let requests = 0;
  const page = '<html><head><title>Device</title></head><body>Ready</body></html>';
  const tunnel = { async loadDevicePage() { requests++; return page; } };
  for (let i = 0; i < 3; i++) {
    const result = await runFallback(tunnel);
    assert.deepEqual(result.writes, ['open', page, 'close']);
  }
  assert.equal(requests, 3);
});

test('a real device request failure is reported without automatically reconnecting', async () => {
  const result = await runFallback({ async loadDevicePage() { throw new Error('Request timed out'); } });
  assert.deepEqual(result.writes, []);
  assert.match(result.message.textContent, /Request timed out/);
  assert.equal(result.message.link.href, '/tunnel/');
  assert.equal(result.message.link.target, '_top');
});

test('opening the fallback outside a tunnel gives a link to the host page', async () => {
  const result = await runFallback(null, true);
  assert.deepEqual(result.writes, []);
  assert.match(result.message.textContent, /No connected tunnel/);
  assert.equal(result.message.link.target, '_top');
});
