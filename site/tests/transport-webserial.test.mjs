import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../static/tunnel/js/transport-webserial.js', import.meta.url), 'utf8');
const { WebSerialTransport, ESPARGOS_USB_FILTERS } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function fixture(vid, pid, { active = false, silent = false, broken = false, booting = false } = {}) {
  const events = [];
  let input, baud, resetHeld = false;
  const transport = new WebSerialTransport();
  transport.port = {
    getInfo: () => ({ usbVendorId: vid, usbProductId: pid }),
    async open({ baudRate }) {
      baud = baudRate;
      events.push(['open', baud]);
      this.readable = new ReadableStream({ start(controller) { input = controller; } });
      if (booting && baud === 115200) {
        setTimeout(() => {
          assert(!active, 'activation must wait for startup');
          events.push(['boot-complete']);
          input.enqueue(new TextEncoder().encode('I (7000) main_task: Returned from app_main()\r\n'));
        }, 400);
      }
      this.writable = new WritableStream({ write(bytes) {
        const text = new TextDecoder().decode(bytes);
        events.push(['write', text]);
        if (text.includes('ESPARGOS-UART-MODE:') && !silent) active = true;
      } });
    },
    async setSignals(signals) {
      events.push(['signals', signals]);
      if (!signals.dataTerminalReady && signals.requestToSend) resetHeld = true;
      if (resetHeld && !signals.dataTerminalReady && !signals.requestToSend) {
        resetHeld = false;
        if (!broken) silent = false;
        events.push(['reset']);
        input.enqueue(new TextEncoder().encode('I (7000) main_task: Returned from app_'));
        input.enqueue(new TextEncoder().encode('main()\r\n'));
      }
    },
    async close() { events.push(['close']); },
  };
  const probe = async (timeout) => {
    events.push(['probe', timeout]);
    return active && baud !== 115200;
  };
  // Stub only the framed receive path. The boot reader, serial writes, signal
  // changes, closing and retry logic all run through the actual transport.
  transport._attach = (onData) => {
    if (booting && !active && baud !== 115200) onData(Uint8Array.of(0));
    transport._closing = false;
    transport._writeDead = false;
    transport._writer = transport.port.writable.getWriter();
  };
  transport._detach = async () => {
    transport._closing = true;
    transport._writer?.releaseLock();
    transport._writer = null;
  };
  return { transport, events, probe };
}

for (const [name, vid, pid, baud] of [
  ['CP2102C', 0x10c4, 0xea64, 3000000],
  ['FT231X', 0x0403, 0x6015, 2000000],
]) {
  test(`${name}: original activation sequence and probe timeout are unchanged`, async () => {
    const { transport, events, probe } = fixture(vid, pid);
    transport._connectCP2102N = () => { throw new Error('wrong adapter path'); };
    const result = await transport.connect({ onData() {}, probe });
    assert.equal(result.baud, baud);
    assert.equal(result.activated, true);
    assert.deepEqual(events.filter(e => e[0] === 'open').map(e => e[1]), [baud, 115200, baud]);
    assert.deepEqual(events.filter(e => e[0] === 'write'), [['write', `ESPARGOS-UART-MODE:${baud}\n`]]);
    assert.deepEqual(events.filter(e => e[0] === 'signals').map(e => e[1]), Array(3).fill({
      dataTerminalReady: true, requestToSend: true,
    }));
    assert.deepEqual(events.filter(e => e[0] === 'probe'), [['probe', undefined], ['probe', undefined]]);
    await transport.disconnect();
  });
}

test('CP2102N: quiet firmware activates promptly, clears a partial line, and is not reset', async () => {
  assert(ESPARGOS_USB_FILTERS.some(f => f.usbVendorId === 0x10c4 && f.usbProductId === 0xea60));
  const { transport, events, probe } = fixture(0x10c4, 0xea60);
  const start = performance.now();
  const result = await transport.connect({ onData() {}, probe });
  assert(performance.now() - start < 2000, 'quiet firmware must not wait eight seconds');
  assert.equal(result.activated, true);
  assert(events.some(e => e[0] === 'write' && e[1] === '\nESPARGOS-UART-MODE:3000000\n'));
  assert(!events.some(e => e[0] === 'reset'));
  assert(events.filter(e => e[0] === 'probe').every(e => e[1] === 250));
  assert.equal(transport.port.readable.locked, false);
  await transport.disconnect();
});

test('CP2102N: retry a lost first HELLO on the same port without reactivation', async () => {
  const { transport, events } = fixture(0x10c4, 0xea60, { active: true });
  let probes = 0;
  const result = await transport.connect({ onData() {}, probe: async () => ++probes === 2 });
  assert.equal(result.activated, false);
  assert.deepEqual(events.filter(e => e[0] === 'open'), [['open', 3000000]]);
  assert.deepEqual(events.filter(e => e[0] === 'write'), [['write', '\0'], ['write', '\0']]);
  await transport.disconnect();
});

test('CP2102N: recover a silent controller with one reset and wait for split boot marker', async () => {
  const { transport, events, probe } = fixture(0x10c4, 0xea60, { silent: true });
  const result = await transport.connect({ onData() {}, probe });
  assert.equal(result.activated, true);
  assert.equal(events.filter(e => e[0] === 'reset').length, 1);
  assert.equal(transport.port.readable.locked, false);
  await transport.disconnect();
});

test('CP2102N: a persistently silent controller must not enter a reset loop', async () => {
  const { transport, events, probe } = fixture(0x10c4, 0xea60, { silent: true, broken: true });
  await assert.rejects(transport.connect({ onData() {}, probe }), /one recovery reset/);
  assert.equal(events.filter(e => e[0] === 'reset').length, 1);
});


test('CP2102N: observed boot data keeps activation waiting for firmware readiness', async () => {
  const { transport, events, probe } = fixture(0x10c4, 0xea60, { booting: true });
  await transport.connect({ onData() {}, probe });
  const bootDone = events.findIndex(e => e[0] === 'boot-complete');
  const activate = events.findIndex(e => e[0] === 'write' && e[1].includes('ESPARGOS-UART-MODE:'));
  assert(bootDone >= 0 && bootDone < activate);
  assert(!events.some(e => e[0] === 'reset'));
  await transport.disconnect();
});

test('CP2102N: a serial read error surfaces instead of causing resets', async () => {
  const { transport, events } = fixture(0x10c4, 0xea60);
  await assert.rejects(transport.connect({ onData() {}, probe: async () => {
    transport._onError(new Error('device lost'));
    return false;
  } }), /device lost/);
  assert(!events.some(e => e[0] === 'reset'));
});
