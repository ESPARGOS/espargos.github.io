// ESPARGOS Web Tunnel — owner page logic.
// Holds the WebSerial link, drives the UART protocol client, registers the Service Worker
// that serves the device UI at /tunnel/device/, answers the SW's tunnelled requests, and
// bridges the device's CSI WebSocket over the same serial link via an injected page shim.

import { EspargosUartClient } from "./uart-client.js";
import { WebSerialTransport } from "./transport-webserial.js";

const DEVICE_URL = "/tunnel/device/";
const SW_URL = "/tunnel/sw.js";

const $ = (id) => document.getElementById(id);
const td = new TextDecoder();
const te = new TextEncoder();
const params = new URLSearchParams(location.search);

let transport = null;
let client = null;
const csiSubs = new Set();
let csiEnabled = false;

function setStatus(msg, kind = "info") {
  const el = $("tunnel-status");
  if (el) {
    el.textContent = msg;
    el.dataset.kind = kind;
  }
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function helloProbe(c) {
  const p = c.hello();
  p.catch(() => {}); // swallow a late timeout rejection if withTimeout wins the race
  try {
    await withTimeout(p, 1500);
    return true;
  } catch (e) {
    return false;
  }
}

async function chooseTransport() {
  // Localhost-gated test hook: tunnel over a WebSocket bridge instead of WebSerial.
  if (params.get("transport") === "ws") {
    const url = params.get("wsurl") || "";
    if (/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      const m = await import("./transport-ws-test.js");
      return new m.WebSocketTestTransport(url);
    }
  }
  return new WebSerialTransport();
}

// ---- CSI bridge exposed to the device iframe (same-origin) ----
function makeTunnelApi() {
  return {
    subscribeCsi(cb) {
      const wrapper = (payload) => {
        try {
          cb(payload); // pass the Uint8Array; the iframe shim copies it into its own realm
        } catch (e) {}
      };
      client.csiCallbacks.push(wrapper);
      csiSubs.add(wrapper);
      if (!csiEnabled) {
        csiEnabled = true;
        client.enableCsi();
      }
      return () => {
        const i = client.csiCallbacks.indexOf(wrapper);
        if (i >= 0) client.csiCallbacks.splice(i, 1);
        csiSubs.delete(wrapper);
        if (csiSubs.size === 0 && csiEnabled) {
          csiEnabled = false;
          client.disableCsi();
        }
      };
    },
  };
}

// ---- Service Worker wiring ----
async function setupServiceWorker() {
  await navigator.serviceWorker.register(SW_URL); // scope defaults to /tunnel/
  const ready = await navigator.serviceWorker.ready;
  navigator.serviceWorker.addEventListener("message", onSwMessage);
  await new Promise((res) => {
    const onMsg = (ev) => {
      if (ev.data && ev.data.type === "owner-registered") {
        navigator.serviceWorker.removeEventListener("message", onMsg);
        res();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    ready.active.postMessage({ type: "register-owner" });
  });
}

async function onSwMessage(ev) {
  const d = ev.data || {};
  if (d.type !== "tunnel-request") return;
  const port = ev.ports && ev.ports[0];
  if (!port) return;
  try {
    const resp = await client.request(d.method, d.path, d.body ? new Uint8Array(d.body) : undefined);
    let body = resp.body;
    if ((d.path === "" || d.path === "/") && /text\/html/i.test(resp.contentType)) body = injectDeviceShim(body);
    port.postMessage({ ok: true, status: resp.status, contentType: resp.contentType, body });
  } catch (e) {
    port.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
}

// Inject a shim into the device index: (1) answer the endpoints the reference UART router
// handles itself — get_transport -> "uart" (so the device UI shows its built-in "updates not
// available over UART" warning and hides the update controls), plus 501 on the firmware-flash
// endpoints — and (2) bridge the device's CSI WebSocket over the serial tunnel.
function injectDeviceShim(bodyBytes) {
  let html = td.decode(bodyBytes);
  if (html.includes("__espargosShim")) return bodyBytes;
  if (!html.includes("<head>")) return bodyBytes;
  return te.encode(html.replace("<head>", "<head>\n" + DEVICE_SHIM));
}

const DEVICE_SHIM = `<script>/*__espargosShim*/(function () {
  var BLOCKED = ["update_firmware", "update_sensor_application", "upload_partition", "trigger_webupdate", "flash_sensor_firmware"];
  function devicePath(u) {
    var p = u.pathname;
    var marker = "/tunnel/device/";
    var i = p.indexOf(marker);
    if (i >= 0) return p.slice(i + marker.length);
    return p.charAt(0) === "/" ? p.slice(1) : p;
  }
  // Mirror espargos-uart-router.py: answer get_transport locally (so the UI knows it is on UART
  // and disables firmware updates) and refuse the firmware-flash endpoints.
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (realFetch) {
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === "string") ? input : (input && input.url) || String(input);
        var u = new URL(url, document.baseURI);
        if (u.origin === location.origin) {
          var path = devicePath(u).split("?")[0];
          if (path === "get_transport") {
            return Promise.resolve(new Response('{"transport":"uart"}', { status: 200, headers: { "Content-Type": "application/json" } }));
          }
          if (BLOCKED.indexOf(path) >= 0) {
            return Promise.resolve(new Response("Firmware updates are not available over the USB tunnel.", { status: 501, headers: { "Content-Type": "text/plain" } }));
          }
        }
      } catch (e) {}
      return realFetch(input, init);
    };
  }
  var Real = window.WebSocket;
  function TunnelCsiSocket() {
    var self = this;
    this.binaryType = "arraybuffer";
    this.readyState = 1;
    this._l = { message: [], open: [], close: [], error: [] };
    this._unsub = window.parent.__espargosTunnel.subscribeCsi(function (payload) {
      // Copy into an ArrayBuffer created in THIS (iframe) realm — otherwise csi.js's
      // \`ev.data instanceof ArrayBuffer\` is false across the owner/iframe realm boundary.
      self._emit("message", { data: new Uint8Array(payload).buffer });
    });
    setTimeout(function () { self._emit("open", {}); }, 0);
  }
  TunnelCsiSocket.prototype.addEventListener = function (t, cb) { (this._l[t] || (this._l[t] = [])).push(cb); };
  TunnelCsiSocket.prototype.removeEventListener = function (t, cb) {
    var a = this._l[t] || [], i = a.indexOf(cb); if (i >= 0) a.splice(i, 1);
  };
  TunnelCsiSocket.prototype._emit = function (t, ev) {
    ev.type = t;
    (this._l[t] || []).forEach(function (cb) { try { cb(ev); } catch (e) {} });
    var on = this["on" + t]; if (typeof on === "function") { try { on.call(this, ev); } catch (e) {} }
  };
  TunnelCsiSocket.prototype.send = function () {};
  TunnelCsiSocket.prototype.close = function () {
    this.readyState = 3; if (this._unsub) this._unsub(); this._emit("close", { code: 1000, wasClean: true });
  };
  window.WebSocket = function (url, protocols) {
    if (String(url).indexOf("/csi") >= 0 && window.parent && window.parent.__espargosTunnel) return new TunnelCsiSocket();
    return new Real(url, protocols);
  };
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
})();<\/script>`;

// ---- connect / disconnect ----
async function connect() {
  $("tunnel-connect").disabled = true;
  try {
    setStatus("Requesting serial port…");
    transport = await chooseTransport();
    await transport.requestPort();

    client = new EspargosUartClient((bytes) => transport.write(bytes));
    window.__espargosClient = client;
    window.__espargosTunnel = makeTunnelApi();

    setStatus("Opening device…");
    const res = await transport.connect({
      onData: (b) => client.feed(b),
      probe: () => helloProbe(client),
      onError: onConnectionLost,
    });
    client.startKeepalive(1000);

    setStatus("Starting tunnel…");
    await setupServiceWorker();

    const hello = await client.hello().catch(() => ({}));
    const via = res.chip && res.baud ? ` via ${res.chip} @ ${res.baud.toLocaleString()} baud` : "";
    setStatus(
      `Connected${hello.device ? " to " + hello.device : ""}${via}${res.activated ? " (activated UART mode)" : ""}.`,
      "ok"
    );
    showDevice();
  } catch (e) {
    console.error(e);
    setStatus("Connection failed: " + ((e && e.message) || e), "error");
    $("tunnel-connect").disabled = false;
    try {
      await transport?.disconnect();
    } catch (err) {}
  }
}

function showDevice() {
  $("tunnel-connect").hidden = true;
  $("tunnel-disconnect").hidden = false;
  $("tunnel-frame-wrap").hidden = false;
  $("tunnel-frame").src = DEVICE_URL;
}

function resetDeviceUI() {
  setFullPage(false);
  $("tunnel-frame").src = "about:blank";
  $("tunnel-frame-wrap").hidden = true;
  $("tunnel-disconnect").hidden = true;
  $("tunnel-connect").hidden = false;
  $("tunnel-connect").disabled = false;
}

// Surface an unexpected mid-session connection loss (read loop errored) so the user can reconnect.
function onConnectionLost(err) {
  console.error("ESPARGOS tunnel connection lost:", err);
  try { client?.stopKeepalive(); } catch (e) {}
  resetDeviceUI();
  setStatus("Connection lost: " + ((err && err.message) || err) + " — click Connect to reconnect.", "error");
}

// ---- full-page (maximize within the page) toggle ----
function setFullPage(on) {
  const wrap = $("tunnel-frame-wrap");
  if (!wrap || wrap.hidden) return;
  wrap.classList.toggle("tunnel-fullpage", on);
  document.body.classList.toggle("tunnel-fullpage-active", on);
  const btn = $("tunnel-fullpage-toggle"); // icon swaps via CSS on the wrap class
  if (btn) btn.title = on ? "Exit full page (Esc)" : "Full page";
}

function toggleFullPage() {
  setFullPage(!$("tunnel-frame-wrap")?.classList.contains("tunnel-fullpage"));
}

async function disconnect() {
  try {
    client?.stopKeepalive();
    await transport?.disconnect();
  } catch (e) {}
  resetDeviceUI();
  setStatus("Disconnected.");
}

function init() {
  const testMode = params.get("transport") === "ws";
  if (!WebSerialTransport.supported && !testMode) {
    if ($("tunnel-unsupported")) $("tunnel-unsupported").hidden = false;
    if ($("tunnel-connect")) $("tunnel-connect").disabled = true;
    return;
  }
  $("tunnel-connect")?.addEventListener("click", connect);
  $("tunnel-disconnect")?.addEventListener("click", disconnect);
  $("tunnel-fullpage-toggle")?.addEventListener("click", toggleFullPage);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setFullPage(false); });
  if (testMode) connect(); // auto-connect for headless integration tests
}

init();
