// ESPARGOS tunnel Service Worker. Scope: /tunnel/ (this file lives at /tunnel/sw.js).
// It serves the device web UI mounted at /tunnel/device/* by forwarding each request to the
// tunnel owner page (which holds the WebSerial link) over a MessageChannel, and building a
// Response from the reply. All other /tunnel/ traffic (the host page, its scripts) passes
// through to the network untouched.
//
// The device UI uses RELATIVE URLs for its API + assets, so from a document at
// /tunnel/device/ they resolve under /tunnel/device/ and are captured here. (Absolute-path
// firmware-update endpoints and the ws:// CSI socket are intentionally not handled: updates
// are unsupported over the tunnel, and CSI is bridged by an injected shim in the page.)

const DEVICE_PREFIX = "/tunnel/device";
let ownerId = null;
let rpcSeq = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "register-owner") {
    ownerId = e.source.id;
    e.source.postMessage({ type: "owner-registered" });
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== DEVICE_PREFIX && !url.pathname.startsWith(DEVICE_PREFIX + "/")) return;
  // Strip the mount prefix AND the leading slash. The device's UART RPC expects RELATIVE paths
  // (exactly like espargos-uart-router.py's "/{path:.*}" capture): "get_netconf", not
  // "/get_netconf". Static files tolerate a leading slash, but API endpoints 404 with one.
  let devicePath = url.pathname.slice(DEVICE_PREFIX.length);
  if (devicePath.startsWith("/")) devicePath = devicePath.slice(1);
  devicePath += url.search;
  event.respondWith(tunnel(event.request, devicePath));
});

// The owner is the tunnel host window (the /tunnel/ page; the device UI lives under /tunnel/device/).
// A Service Worker can be terminated when idle and restarted on the next event, wiping ownerId — so
// never rely on it alone: re-locate the host window via clients.matchAll() each time.
async function getOwner() {
  if (ownerId) {
    const c = await self.clients.get(ownerId);
    if (c) return c;
  }
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const host = wins.find((c) => {
    try {
      return new URL(c.url).pathname.replace(/index\.html$/, "") === "/tunnel/";
    } catch (e) {
      return false;
    }
  });
  if (host) {
    ownerId = host.id;
    return host;
  }
  return null;
}

async function tunnel(request, devicePath) {
  const owner = await getOwner();
  if (!owner) {
    return new Response("ESPARGOS tunnel is not connected. Open the tunnel page and connect a device.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = Array.from(new Uint8Array(await request.arrayBuffer()));
  }
  const result = await rpc(owner, { method: request.method, path: devicePath, body });
  if (!result || !result.ok) {
    return new Response("ESPARGOS tunnel error: " + (result && result.error), { status: 502 });
  }
  const bytes = result.body && result.body.length ? new Uint8Array(result.body) : null;
  return new Response(bytes, {
    status: result.status,
    headers: { "Content-Type": result.contentType || "application/octet-stream" },
  });
}

function rpc(owner, payload) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    owner.postMessage({ type: "tunnel-request", id: ++rpcSeq, ...payload }, [ch.port2]);
  });
}
