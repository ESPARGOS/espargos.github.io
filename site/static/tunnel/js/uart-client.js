// ESPARGOS UART client. JS port of pyespargos/espargos/uart.py UARTClient.
// Transport-agnostic: constructed with a `send(Uint8Array)` sink; call feed(bytes) with whatever
// the byte transport delivers. Multiplexes RPC requests/responses by request id and dispatches
// CSI/log frames to registered callbacks.

import {
  FRAME,
  STREAM_ID,
  FrameDecoder,
  buildFrame,
  packRpcRequest,
  unpackRpcResponse,
  unpackHello,
  packStreamCtrl,
} from "./protocol.js";

export class EspargosUartClient {
  constructor(send, { timeout = 5000 } = {}) {
    this._send = send; // (Uint8Array) => void
    this.timeout = timeout;
    this._decoder = new FrameDecoder();
    this._pending = new Map(); // reqId -> { resolve, reject, expectType, timer }
    this._reqId = 1;
    this.csiCallbacks = [];
    this.logCallbacks = [];
    this._keepaliveTimer = null;
  }

  // Ingest raw bytes from the transport.
  feed(chunk) {
    for (const frame of this._decoder.push(chunk)) this._handleFrame(frame);
  }

  _allocId() {
    const id = this._reqId;
    this._reqId = this._reqId === 0xffff ? 1 : this._reqId + 1;
    return id;
  }

  _request(frameType, payload, expectType) {
    const reqId = this._allocId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`UART request ${reqId} timed out`));
      }, this.timeout);
      this._pending.set(reqId, { resolve, reject, expectType, timer });
      this._send(buildFrame(frameType, reqId, payload));
    });
  }

  async hello() {
    return unpackHello(await this._request(FRAME.HELLO_REQ, new Uint8Array(0), FRAME.HELLO_RESP));
  }

  // Mirrors UARTRouter.handle_http: method + path + body -> {status, contentType, body}
  async request(method, path, body) {
    return unpackRpcResponse(
      await this._request(FRAME.RPC_REQ, packRpcRequest(method, path, body), FRAME.RPC_RESP)
    );
  }

  enableCsi() {
    this._send(buildFrame(FRAME.STREAM_CTRL, 0, packStreamCtrl(STREAM_ID.CSI, true)));
  }

  disableCsi() {
    this._send(buildFrame(FRAME.STREAM_CTRL, 0, packStreamCtrl(STREAM_ID.CSI, false)));
  }

  startKeepalive(intervalMs = 1000) {
    this.stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      this._send(buildFrame(FRAME.STREAM_CTRL, 0, packStreamCtrl(STREAM_ID.TRANSPORT, true)));
    }, intervalMs);
  }

  stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _handleFrame({ frameType, requestId, payload }) {
    if (frameType === FRAME.HELLO_RESP || frameType === FRAME.RPC_RESP) {
      const p = this._pending.get(requestId);
      if (!p) return;
      this._pending.delete(requestId);
      clearTimeout(p.timer);
      if (frameType !== p.expectType) {
        p.reject(new Error(`Unexpected response type 0x${frameType.toString(16)} for request ${requestId}`));
        return;
      }
      p.resolve(payload);
      return;
    }
    if (frameType === FRAME.CSI_DATA) {
      for (const cb of this.csiCallbacks) cb(payload);
      return;
    }
    if (frameType === FRAME.LOG) {
      const text = new TextDecoder().decode(payload);
      for (const cb of this.logCallbacks) cb(text);
    }
  }
}
