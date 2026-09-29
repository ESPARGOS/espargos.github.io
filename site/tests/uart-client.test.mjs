import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const protocolURL = asModule(await readFile(new URL('../static/tunnel/js/protocol.js', import.meta.url), 'utf8'));
const clientSource = (await readFile(new URL('../static/tunnel/js/uart-client.js', import.meta.url), 'utf8'))
  .replace('"./protocol.js"', JSON.stringify(protocolURL));
const { EspargosUartClient } = await import(asModule(clientSource));
const { parseFrame, buildFrame, FRAME } = await import(protocolURL);

test('a short HELLO timeout removes its pending request without changing subsequent timeouts', async () => {
  const sent = [];
  const client = new EspargosUartClient(bytes => sent.push(bytes), { timeout: 5000 });
  await assert.rejects(client.hello({ timeout: 10 }), /timed out/);
  assert.equal(client._pending.size, 0);
  assert.equal(client.timeout, 5000);
  const next = client.hello();
  const request = parseFrame(sent.at(-1).subarray(0, sent.at(-1).length - 1));
  client.feed(buildFrame(FRAME.HELLO_RESP, request.requestId, new Uint8Array()));
  assert.deepEqual(await next, {});
  assert.equal(client._pending.size, 0);
});
