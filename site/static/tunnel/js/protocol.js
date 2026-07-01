// ESPARGOS UART protocol — JS port of pyespargos/espargos/uart.py
// Pure, transport-agnostic. Shared by the WebSerial client and the test simulator.

export const UART_PROTOCOL_VERSION = 1;

export const FRAME = {
  HELLO_REQ: 0x01,
  HELLO_RESP: 0x02,
  RPC_REQ: 0x10,
  RPC_RESP: 0x11,
  CSI_DATA: 0x20,
  STREAM_CTRL: 0x21,
  LOG: 0x30,
};

export const STREAM_ID = { TRANSPORT: 0, CSI: 1 };
export const RPC_METHOD = { GET: 0, POST: 1 };
export const CSISTREAM_MAGIC = Uint8Array.from([0xe5, 0xa7, 0x60, 0x00]);

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- COBS (Consistent Overhead Byte Stuffing) ----

export function cobsEncode(data) {
  if (data.length === 0) return Uint8Array.from([0x01]);
  const out = [0];
  let codeIndex = 0;
  let code = 1;
  for (const b of data) {
    if (b === 0) {
      out[codeIndex] = code;
      codeIndex = out.length;
      out.push(0);
      code = 1;
    } else {
      out.push(b);
      code += 1;
      if (code === 0xff) {
        out[codeIndex] = code;
        codeIndex = out.length;
        out.push(0);
        code = 1;
      }
    }
  }
  out[codeIndex] = code;
  return Uint8Array.from(out);
}

export function cobsDecode(data) {
  if (data.length === 0) throw new Error("Received empty COBS frame");
  const out = [];
  let idx = 0;
  const length = data.length;
  while (idx < length) {
    const code = data[idx];
    if (code === 0) throw new Error("COBS frame contains zero byte");
    idx += 1;
    const end = idx + code - 1;
    if (end > length) throw new Error("COBS frame is truncated");
    for (let i = idx; i < end; i++) out.push(data[i]);
    idx = end;
    if (code !== 0xff && idx < length) out.push(0);
  }
  return Uint8Array.from(out);
}

// ---- Frame build/parse (COBS + 0x00 delimiter, <BBHI> header) ----

export function buildFrame(frameType, requestId, payload) {
  const body = new Uint8Array(8 + payload.length);
  const dv = new DataView(body.buffer);
  dv.setUint8(0, UART_PROTOCOL_VERSION);
  dv.setUint8(1, frameType);
  dv.setUint16(2, requestId & 0xffff, true);
  dv.setUint32(4, payload.length, true);
  body.set(payload, 8);
  const encoded = cobsEncode(body);
  const frame = new Uint8Array(encoded.length + 1);
  frame.set(encoded, 0);
  frame[encoded.length] = 0x00;
  return frame;
}

export function parseFrame(rawFrame) {
  const decoded = cobsDecode(rawFrame);
  if (decoded.length < 8) throw new Error("Frame too short");
  const dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const version = dv.getUint8(0);
  if (version !== UART_PROTOCOL_VERSION)
    throw new Error(`Unsupported UART protocol version ${version}`);
  const frameType = dv.getUint8(1);
  const requestId = dv.getUint16(2, true);
  const payloadLen = dv.getUint32(4, true);
  const payload = decoded.subarray(8);
  if (payload.length !== payloadLen) throw new Error("Frame payload length mismatch");
  return { frameType, requestId, payload };
}

// Stream splitter: feed raw bytes, get back complete decoded frames.
// Mirrors UARTClient._read_one_frame: split on 0x00, drop frames that fail to parse (resync).
export class FrameDecoder {
  constructor() {
    this.buf = [];
  }
  push(chunk) {
    const frames = [];
    for (const b of chunk) {
      if (b === 0) {
        if (this.buf.length > 0) {
          try {
            frames.push(parseFrame(Uint8Array.from(this.buf)));
          } catch {
            /* ignore invalid frame, resync */
          }
        }
        this.buf = [];
      } else {
        this.buf.push(b);
      }
    }
    return frames;
  }
}

// ---- RPC payload pack/unpack ----

export function packRpcRequest(method, path, body) {
  const methodId = method.toUpperCase() === "GET" ? RPC_METHOD.GET : RPC_METHOD.POST;
  const pathBytes = enc.encode(path);
  const bodyBytes = body == null ? new Uint8Array(0) : body instanceof Uint8Array ? body : enc.encode(String(body));
  const out = new Uint8Array(7 + pathBytes.length + bodyBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, methodId); // <BHI
  dv.setUint16(1, pathBytes.length, true);
  dv.setUint32(3, bodyBytes.length, true);
  out.set(pathBytes, 7);
  out.set(bodyBytes, 7 + pathBytes.length);
  return out;
}

export function parseRpcRequest(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const methodId = dv.getUint8(0);
  const pathLen = dv.getUint16(1, true);
  const bodyLen = dv.getUint32(3, true);
  const path = dec.decode(payload.subarray(7, 7 + pathLen));
  const body = payload.subarray(7 + pathLen, 7 + pathLen + bodyLen);
  return { method: methodId === RPC_METHOD.GET ? "GET" : "POST", path, body };
}

export function packRpcResponse(status, contentType, body) {
  const ctBytes = enc.encode(contentType || "");
  const bodyBytes = body == null ? new Uint8Array(0) : body instanceof Uint8Array ? body : enc.encode(String(body));
  const out = new Uint8Array(8 + ctBytes.length + bodyBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, status, true); // <HHI
  dv.setUint16(2, ctBytes.length, true);
  dv.setUint32(4, bodyBytes.length, true);
  out.set(ctBytes, 8);
  out.set(bodyBytes, 8 + ctBytes.length);
  return out;
}

export function unpackRpcResponse(payload) {
  if (payload.length < 8) throw new Error("RPC response too short");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const status = dv.getUint16(0, true);
  const ctLen = dv.getUint16(2, true);
  const bodyLen = dv.getUint32(4, true);
  const expected = 8 + ctLen + bodyLen;
  if (payload.length !== expected) throw new Error("RPC response length mismatch");
  return {
    status,
    contentType: dec.decode(payload.subarray(8, 8 + ctLen)),
    body: payload.subarray(8 + ctLen, expected),
  };
}

// ---- HELLO pack/unpack ----

export function packHello(device, revision, apiMajor, apiMinor) {
  const d = enc.encode(device);
  const r = enc.encode(revision);
  const out = new Uint8Array(8 + d.length + r.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, d.length, true);
  dv.setUint16(2, r.length, true);
  dv.setUint16(4, apiMajor, true);
  dv.setUint16(6, apiMinor, true);
  out.set(d, 8);
  out.set(r, 8 + d.length);
  return out;
}

export function unpackHello(payload) {
  if (payload.length === 0) return {};
  if (payload.length < 8) throw new Error("HELLO response too short");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const deviceLen = dv.getUint16(0, true);
  const revisionLen = dv.getUint16(2, true);
  const apiMajor = dv.getUint16(4, true);
  const apiMinor = dv.getUint16(6, true);
  const expected = 8 + deviceLen + revisionLen;
  if (payload.length !== expected) throw new Error("HELLO response has invalid payload length");
  return {
    device: dec.decode(payload.subarray(8, 8 + deviceLen)),
    revision: dec.decode(payload.subarray(8 + deviceLen, expected)),
    apiMajor,
    apiMinor,
  };
}

export function packStreamCtrl(streamId, enable) {
  return Uint8Array.from([streamId, enable ? 1 : 0]);
}

export function parseStreamCtrl(payload) {
  return { streamId: payload[0], enable: payload[1] !== 0 };
}
