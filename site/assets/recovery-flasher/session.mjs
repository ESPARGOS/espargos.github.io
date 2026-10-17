import {RecoveryReset, recoveryTransport, resetToFirmware} from './reset.mjs';
// The same compressed-write and read-back verification flow as ESP-WebSDR.
export const FLASH_SIZE = 16 * 1024 * 1024;
export const BAUD_RATE = 2000000;
// Bound the amount of erase/write work hidden in one compressed block. Recovery
// images contain large runs of 0xff, unlike the small application images used by
// ESP-WebSDR. Each section is sector-aligned and acknowledged before the next.
export const WRITE_SECTION_SIZE = 256 * 1024;

export function validateImage(image, channel) {
  if (!['stable', 'testing', 'dev'].includes(channel) ||
      image?.path !== `${channel}/espargos-controller-recovery.bin` ||
      image.size !== FLASH_SIZE || !/^[a-f0-9]{64}$/.test(image.sha256) ||
      !/^[a-f0-9]{32}$/.test(image.md5)) {
    throw Error('Invalid recovery image metadata. Reload this page and try again.');
  }
}

export class RecoverySession {
  constructor({ESPLoader, Transport, fetchImage = (...args) => globalThis.fetch(...args), cryptoApi = crypto, log = () => {}}) {
    Object.assign(this, {ESPLoader, Transport, fetchImage, cryptoApi, log});
    this.loader = null;
    this.transport = null;
  }

  async connect(port) {
    const Transport = recoveryTransport(this.Transport);
    this.transport = new Transport(port, false);
    try {
      this.loader = new this.ESPLoader({
        transport: this.transport, baudrate: 115200,
        serialOptions: {flowControl: 'none'},
        resetConstructors: {classicReset: (transport, delay) => new RecoveryReset(transport, delay)},
        terminal: {clean() {}, write: this.log, writeLine: line => this.log(line + '\n')}
      });
      await this.loader.main();
      if (this.loader.chip.CHIP_NAME !== 'ESP32') {
        throw Error(`Connected ${this.loader.chip.CHIP_NAME}. Recovery requires the ESPARGOS ESP32 controller.`);
      }
      const size = await this.loader.detectFlashSize();
      if (size !== '16MB') throw Error(`Expected 16 MB flash, detected ${size}.`);
      return `ESP32 · ${size}`;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async install(image, channel, firmwareBase, onProgress, onStatus) {
    if (!this.loader) throw Error('Connect the controller first.');
    validateImage(image, channel);
    onStatus('Downloading recovery image…');
    const url = new URL(image.path, firmwareBase);
    url.searchParams.set('sha256', image.sha256);
    const response = await this.fetchImage(url, {cache: 'no-store'});
    if (!response.ok) throw Error(`Recovery download failed (${response.status}).`);
    const data = new Uint8Array(await response.arrayBuffer());
    const hash = new Uint8Array(await this.cryptoApi.subtle.digest('SHA-256', data));
    const hex = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    if (data.length !== image.size || hex !== image.sha256 || data[0x1000] !== 0xe9) {
      throw Error('Recovery image check failed. Reload this page and try again.');
    }
    onStatus('Setting flashing speed to 2 Mbaud…');
    this.loader.baudrate = BAUD_RATE;
    await this.loader.changeBaud();
    if (this.transport.baudrate !== BAUD_RATE) {
      throw Error('Could not switch to 2 Mbaud. Reconnect and retry, or use manual recovery below.');
    }
    onStatus('Installing recovery firmware. Keep the USB cable connected.');
    const fileArray = [];
    for (let address = 0; address < data.length; address += WRITE_SECTION_SIZE) {
      fileArray.push({address, data: data.subarray(address, address + WRITE_SECTION_SIZE)});
    }
    await this.loader.writeFlash({
      fileArray,
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      eraseAll: false, compress: true,
      reportProgress: (index, written, total) => {
        const section = fileArray[index];
        const completed = section.address + (total ? written / total * section.data.length : 0);
        onProgress(completed / data.length * 95);
        if (completed === data.length) onStatus('Finishing the write. Keep the USB cable connected.');
      }
    });
    onStatus('Verifying flash contents…');
    const actual = await this.loader.flashMd5sum(0, image.size);
    if (actual.toLowerCase() !== image.md5) throw Error('Flash verification failed. Reconnect and try again.');
    onProgress(100);
    return this.close();
  }

  async close() {
    const transport = this.transport;
    this.loader = null;
    this.transport = null;
    if (!transport) return false;
    let reset = false;
    try {
      await resetToFirmware(transport);
      reset = true;
    } catch (error) {
      this.log(`Reset could not be confirmed: ${error.message}\n`);
    }
    try { await transport.disconnect(); }
    catch (error) { this.log(`Port close: ${error.message}\n`); reset = false; }
    return reset;
  }
}
