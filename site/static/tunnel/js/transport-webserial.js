// WebSerial byte transport for the ESPARGOS tunnel.
// Replicates the open / baud / modem-signal / UART-mode-activation logic that pyespargos
// (espargos/uart.py) uses, expressed against the WebSerial API.
//
// NOTE: WebSerial can only assert DTR/RTS *after* port.open(); the open transition itself is the
// part that can reboot the device (the ESP32 auto-reset circuit). The FTDI FT231X is more
// sensitive to this than the CP2102C, so connect() retries the open + UART-mode activation a few
// times, settles after each open, and the read loop surfaces unexpected errors via onError so the
// UI can recover (and the user can reconnect) instead of the tunnel silently dying.

const FT231X = 0x6015; // FTDI FT231X    (vendor 0x0403) -> 2 Mbaud  (matches uart.py FT231XQ)
const CP2102C = 0xea64; // SiLabs CP2102C (vendor 0x10c4) -> 3 Mbaud

export const ESPARGOS_USB_FILTERS = [
  { usbVendorId: 0x0403, usbProductId: FT231X },
  { usbVendorId: 0x10c4, usbProductId: CP2102C },
];

const BAUD_BY_PID = { [FT231X]: 2000000, [CP2102C]: 3000000 };
const CHIP_BY_PID = { [FT231X]: "FTDI FT231X", [CP2102C]: "SiLabs CP2102C" };
const SAFE_FALLBACK_BAUD = 2000000; // lower, safer rate if the PID is somehow unavailable
const BOOT_BAUD = 115200;
const OPEN_SETTLE_MS = 150;
const CONNECT_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Yield to the MACROTASK queue. Under heavy CSI the WebSerial readable stream always has buffered
// chunks, so `reader.read()` resolves via microtasks and a tight read loop never lets tasks run —
// starving the Service Worker's postMessage (which carries RPC requests) and timers, so commands
// silently stop while CSI (handled inside the read loop) keeps flowing. A MessageChannel round-trip
// is a real task with no setTimeout clamping, so this keeps throughput high while staying fair.
let _yieldChannel = null;
const _yieldResolvers = [];
function yieldToTasks() {
  if (typeof MessageChannel === "undefined") return new Promise((r) => setTimeout(r));
  if (!_yieldChannel) {
    _yieldChannel = new MessageChannel();
    _yieldChannel.port1.onmessage = () => {
      const r = _yieldResolvers.shift();
      if (r) r();
    };
    _yieldChannel.port1.start();
  }
  return new Promise((resolve) => {
    _yieldResolvers.push(resolve);
    _yieldChannel.port2.postMessage(0);
  });
}

export class WebSerialTransport {
  constructor() {
    this.kind = "webserial";
    this.port = null;
    this._reader = null;
    this._writer = null;
    this._onData = null;
    this._onError = null;
    this._readLoop = null;
    this._closing = false;
    this._writeChain = Promise.resolve();
    this._writeDead = false;
  }

  static get supported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  async requestPort() {
    this.port = await navigator.serial.requestPort({ filters: ESPARGOS_USB_FILTERS });
    return this.port;
  }

  // Adapter chip + baud, selected by USB VID/PID exactly like pyespargos' USB_UART_BAUDRATES.
  info() {
    const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
    const pid = i.usbProductId;
    return {
      pid,
      chip: CHIP_BY_PID[pid] || `USB ${(i.usbVendorId || 0).toString(16)}:${(pid || 0).toString(16)}`,
      baud: BAUD_BY_PID[pid] || SAFE_FALLBACK_BAUD,
    };
  }

  async _open(baud) {
    await this.port.open({ baudRate: baud, bufferSize: 1 << 16, flowControl: "none" });
    // Hold DTR & RTS asserted: the no-reset idle state for the FT231X / CP2102C adapters.
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (e) {
      /* some platforms reject setSignals; non-fatal */
    }
    await sleep(OPEN_SETTLE_MS); // let the lines settle / device stabilise after any open glitch
  }

  async _closePort() {
    try {
      await this.port.close();
    } catch (e) {
      /* ignore */
    }
  }

  _attach(onData) {
    this._onData = onData;
    this._closing = false;
    this._writeChain = Promise.resolve();
    this._writeDead = false;
    this._writer = this.port.writable.getWriter();
    this._readLoop = (async () => {
      const reader = this.port.readable.getReader();
      this._reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length && this._onData) this._onData(value);
          await yieldToTasks(); // let SW requests / timers run; don't starve the event loop
        }
      } catch (e) {
        if (!this._closing && this._onError) this._onError(e); // surface unexpected connection loss
      } finally {
        try {
          reader.releaseLock();
        } catch (e) {}
      }
    })();
  }

  async _detach() {
    this._closing = true;
    try { await this._reader?.cancel(); } catch (e) {}
    try { await this._readLoop; } catch (e) {}
    try { await this._writer?.releaseLock(); } catch (e) {}
    this._reader = null;
    this._writer = null;
    this._readLoop = null;
  }

  // Callers fire-and-forget writes (RPC requests, keepalive, CSI control) from several places.
  // Serialize them through one chain and await writer.ready for backpressure, so concurrent writes
  // can't desync or push the WritableStream into a permanently-errored state (which would silently
  // kill all host->device commands while the device keeps streaming CSI back). A genuine write
  // failure is surfaced once via onError so the UI can prompt a reconnect instead of dying silently.
  write(bytes) {
    this._writeChain = this._writeChain.then(
      () => this._doWrite(bytes),
      () => this._doWrite(bytes)
    );
    return this._writeChain;
  }

  async _doWrite(bytes) {
    if (!this._writer || this._writeDead || this._closing) return;
    try {
      await this._writer.ready; // respect backpressure instead of overflowing the stream
      await this._writer.write(bytes);
    } catch (e) {
      if (!this._closing) {
        this._writeDead = true;
        if (this._onError) this._onError(e);
      }
    }
  }

  // Open the port; if the device does not answer, run the UART-mode activation handshake.
  // The whole sequence is retried because opening an FT231X can glitch the ESP32 reset line.
  async connect({ onData, probe, onError }) {
    const { baud, chip } = this.info();
    let lastErr = null;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try {
        const res = await this._connectOnce(baud, onData, probe);
        this._onError = onError || null; // only surface losses once we're actually connected
        return { ...res, chip, attempt };
      } catch (e) {
        lastErr = e;
        try { await this._detach(); } catch (err) {}
        try { await this._closePort(); } catch (err) {}
        if (attempt < CONNECT_ATTEMPTS) await sleep(400);
      }
    }
    throw lastErr || new Error("could not connect to device");
  }

  async _connectOnce(baud, onData, probe) {
    await this._open(baud);
    this._attach(onData);
    if (await probe()) return { activated: false, baud };

    // No answer at the target baud -> switch the device into UART transport mode.
    await this._detach();
    await this._closePort();

    await this._open(BOOT_BAUD);
    const w = this.port.writable.getWriter();
    try {
      await w.write(new TextEncoder().encode(`ESPARGOS-UART-MODE:${baud}\n`));
    } finally {
      try { w.releaseLock(); } catch (e) {}
    }
    await sleep(250);
    await this._closePort();

    await this._open(baud);
    this._attach(onData);
    if (await probe()) return { activated: true, baud };
    throw new Error("device did not respond after UART-mode activation");
  }

  async disconnect() {
    await this._detach();
    await this._closePort();
  }
}
