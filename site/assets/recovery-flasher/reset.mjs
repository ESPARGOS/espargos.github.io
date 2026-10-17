// CP2102C's always-on flow control reasserts RTS on received UART data if
// DTR is released. See https://github.com/espressif/esptool/pull/1157.
// The Windows signal ordering and final reset preserve the previous working
// https://github.com/Jeija/esptool-js/tree/espargos implementation.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function usesHardwareFlowControl(port) {
  const info = port.getInfo?.() || {};
  return info.usbVendorId === 0x10c4 && info.usbProductId === 0xea64;
}
export function isWindows(navigator = globalThis.navigator) {
  return /win/i.test(navigator?.userAgentData?.platform || navigator?.platform || navigator?.userAgent || '');
}
export function recoveryTransport(BaseTransport, windows = isWindows()) {
  return class extends BaseTransport {
    async setSignals(dtr, rts, breakSignal) {
      // Keep the upstream state cache accurate even when DTR is false.
      if (dtr !== undefined) this._DTR_state = dtr;
      if (windows && usesHardwareFlowControl(this.device) && dtr !== undefined && rts !== undefined) {
        // Windows applies a combined request DTR-first. The ESPARGOS reset
        // circuit needs RTS-first on this adapter instead.
        await this.device.setSignals({requestToSend: rts});
        await this.device.setSignals({dataTerminalReady: dtr});
      } else {
        await this.device.setSignals({dataTerminalReady: dtr, requestToSend: rts, break: breakSignal});
      }
    }
  };
}
export class RecoveryReset {
  constructor(transport, delay) { this.transport = transport; this.delay = delay; }
  async reset() {
    const t = this.transport;
    await t.setSignals(false, false);
    await t.setSignals(true, true);
    await t.setSignals(false, true);
    await sleep(100);
    await t.setSignals(true, false);
    await sleep(this.delay);
    // CP2102C must retain DTR throughout synchronization and flashing.
    if (!usesHardwareFlowControl(t.device)) await t.setSignals(false, false);
  }
}
export async function resetToFirmware(transport) {
  await transport.setSignals(false, true);
  await sleep(100);
  if (usesHardwareFlowControl(transport.device)) {
    await transport.setSignals(true, true);
    await sleep(100);
    await transport.setSignals(true, false);
    // Web Serial cannot clear HUPCL. Keep DTR asserted across close, as in
    // the former browser flasher. If the OS holds EN low after close, the
    // user can power-cycle without repeating the verified installation.
  } else {
    await transport.setSignals(false, false);
  }
}
