// Test-only byte transport: tunnels over a WebSocket to a local bridge instead of WebSerial,
// so the tunnel UI + Service Worker can be exercised headlessly without hardware.
// Loaded only via ?transport=ws&wsurl=ws://127.0.0.1:.../ (localhost-gated in tunnel-app.js).
export class WebSocketTestTransport {
  constructor(url) {
    this.kind = "websocket-test";
    this.url = url;
    this.ws = null;
    this._onData = null;
  }

  static get supported() {
    return true;
  }

  async requestPort() {
    /* no chooser needed */
  }

  async write(bytes) {
    this.ws.send(bytes);
  }

  async connect({ onData, probe }) {
    this._onData = onData;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("test websocket failed to open"));
    });
    this.ws.onmessage = (ev) => onData(new Uint8Array(ev.data));
    if (await probe()) return { activated: false };
    throw new Error("device did not respond (test transport)");
  }

  async disconnect() {
    try {
      this.ws?.close();
    } catch (e) {}
  }
}
