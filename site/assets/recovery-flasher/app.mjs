import {ESPLoader, Transport} from './vendor/esptool-js-0.7.0.js';
import {RecoverySession, validateImage} from './session.mjs';

const root = document.getElementById('recovery-flasher');
const $ = name => root.querySelector(`[data-recovery="${name}"]`);
const supported = isSecureContext && !!navigator.serial;
let busy = false, catalog = null;
const log = text => {
  $('log').textContent = ($('log').textContent + text).slice(-60000);
  $('log').scrollTop = $('log').scrollHeight;
};
const session = new RecoverySession({ESPLoader, Transport, log});
function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('text-danger', error);
}
function controls() {
  $('connect').disabled = !supported || busy || !!session.loader;
  $('disconnect').disabled = busy || !session.loader;
  $('channel').disabled = busy || !catalog;
  $('confirm').disabled = busy;
  $('install').disabled = busy || !catalog || !session.loader || !$('confirm').checked;
}
function selection() {
  const image = catalog?.channels[$('channel').value];
  $('build').textContent = image ? `${image.build_date.slice(0, 10)} · ${image.version}` : '';
  $('confirm').checked = false;
  controls();
}
$('channel').addEventListener('change', selection);
$('confirm').addEventListener('change', controls);
$('connect').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  controls();
  $('log').textContent = '';
  try {
    // Request the port inside the click handler to preserve user activation.
    status('Choose the controller’s USB port.');
    const port = await navigator.serial.requestPort();
    status('Connecting to the controller…');
    $('device').textContent = await session.connect(port);
    status('Connected. Choose a channel, then install the recovery image.');
  } catch (error) {
    status(error.name === 'NotFoundError' ? 'No device selected.' : `${error.message} Close other serial programs and try again.`, error.name !== 'NotFoundError');
  } finally { busy = false; controls(); }
});
$('disconnect').addEventListener('click', async () => {
  busy = true; controls();
  const reset = await session.close();
  $('device').textContent = 'Not connected';
  status(reset ? 'Disconnected. Restart requested.' : 'Disconnected. Unplug and reconnect USB to restart.');
  busy = false; controls();
});
$('install').addEventListener('click', async () => {
  if (busy || !catalog || !session.loader || !$('confirm').checked) return;
  busy = true; controls(); $('progress').value = 0;
  const start = performance.now();
  try {
    const channel = $('channel').value;
    const reset = await session.install(catalog.channels[channel], channel,
      new URL(root.dataset.firmwareBase, document.baseURI), value => { $('progress').value = value; }, status);
    const seconds = Math.round((performance.now() - start) / 1000);
    status(`Recovery installed and verified in ${seconds} seconds. ${reset ? 'Restart requested.' : 'Unplug and reconnect USB to restart.'} Continue with the setup guide.`);
  } catch (error) {
    status(`${error.message} Recovery did not finish. Reconnect to retry.`, true);
    await session.close();
  } finally {
    $('device').textContent = 'Not connected';
    $('confirm').checked = false;
    busy = false; controls();
  }
});
window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
controls();
if (!supported) {
  status('Use Chrome or Edge on a computer, over HTTPS or localhost, to flash via USB. You can also use manual recovery below.');
} else {
  status('Connect ESPARGOS via USB, then click Connect controller.');
  $('build').textContent = 'Loading available firmware…';
  try {
    const response = await fetch(new URL(root.dataset.catalog, document.baseURI), {cache: 'no-store'});
    if (!response.ok) throw Error(`Catalog request failed (${response.status}).`);
    const available = await response.json();
    if (!available.channels || !Object.keys(available.channels).length) throw Error('No recovery images available.');
    for (const [channel, image] of Object.entries(available.channels)) {
      validateImage(image, channel);
    }
    for (const channel of Object.keys(available.channels)) {
      const option = document.createElement('option');
      option.value = channel;
      option.textContent = channel[0].toUpperCase() + channel.slice(1);
      $('channel').append(option);
    }
    catalog = available;
    selection();
  } catch (error) {
    catalog = null;
    $('build').textContent = `Could not load recovery images: ${error.message} Reload the page to retry.`;
    controls();
  }
}
