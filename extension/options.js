import { appOrigin, batches, DEFAULT_APP, flattenTree, originPattern } from './lib.js';

const $ = (id) => document.getElementById(id);
const plural = (count, one, many) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const send = (message) => chrome.runtime.sendMessage(message);

async function render() {
  const { connection, mirror = true, queue = [], disconnected, lastError, lastApp } = await chrome.storage.local.get(['connection', 'mirror', 'queue', 'disconnected', 'lastError', 'lastApp']);
  $('connect-section').hidden = !!connection;
  $('connected-section').hidden = !connection;
  $('import-section').hidden = !connection;
  if (!$('address').value) $('address').value = lastApp ?? DEFAULT_APP;
  if (!connection) return;
  $('home').textContent = connection.app;
  $('mirror').checked = mirror;
  $('broken').hidden = !disconnected;
  $('broken').textContent = disconnected ? `${lastError ?? 'Bookmarks no longer accepts this browser'}. Disconnect, then connect again.` : '';
  $('queue').hidden = !queue.length;
  $('queue').textContent = queue.length ? `${plural(queue.length, 'link is', 'links are')} waiting to send.` : '';
  const links = flattenTree(await chrome.bookmarks.getTree());
  if (!$('import').dataset.busy) {
    $('import').textContent = `Import ${plural(links.length, 'bookmark', 'bookmarks')}`;
    $('import').disabled = !links.length;
  }
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = (text) => { $('connect-error').textContent = text; $('connect-error').hidden = !text; };
  error('');
  $('disconnect-note').hidden = true;
  const app = appOrigin($('address').value);
  if (!app) return error('That is not a Bookmarks address. Use the address Bookmarks shows, such as http://127.0.0.1:4316.');
  // The browser only shows this prompt straight from the click, so nothing is awaited before it.
  const allowed = await chrome.permissions.request({ origins: [originPattern(app)] });
  if (!allowed) return error(`The extension needs to reach ${app} to save links there.`);
  $('connect-button').disabled = true;
  await chrome.storage.local.set({ lastApp: app });
  const result = await send({ type: 'connect', app });
  $('connect-button').disabled = false;
  if (!result?.ok) return error(result?.message ?? `Could not connect to ${app}. Check that Bookmarks is running, then try again.`);
  await render();
});

$('mirror').addEventListener('change', () => chrome.storage.local.set({ mirror: $('mirror').checked }));

$('disconnect').addEventListener('click', async () => {
  const { connection } = await chrome.storage.local.get('connection');
  $('disconnect').disabled = true;
  const result = await send({ type: 'disconnect' });
  $('disconnect').disabled = false;
  if (connection) await chrome.permissions.remove({ origins: [originPattern(connection.app)] }).catch(() => undefined);
  // The extension has forgotten its token. If Bookmarks didn't answer, the connection is still listed there.
  $('disconnect-note').hidden = !!result?.told;
  $('disconnect-note').textContent = result?.told ? '' : `Disconnected here, but ${connection?.app ?? 'Bookmarks'} didn't answer. Remove this browser in Bookmarks' Settings too.`;
  await render();
});

$('import').addEventListener('click', async () => {
  const { connection } = await chrome.storage.local.get('connection');
  if (!connection) return;
  const links = flattenTree(await chrome.bookmarks.getTree());
  $('import').disabled = true;
  $('import').dataset.busy = '1';
  let sent = 0, dropped = 0, problem = null;
  for (const batch of batches(links)) {
    $('import-status').textContent = `Sending ${sent.toLocaleString()} of ${links.length.toLocaleString()}`;
    const result = await send({ type: 'send', via: 'bookmark', items: batch });
    sent += result.done - result.dropped;
    dropped += result.dropped;
    if (result.outcome !== 'ok') { problem = result.message; break; }
  }
  delete $('import').dataset.busy;
  $('import').disabled = false;
  const refused = dropped ? ` Bookmarks refused ${plural(dropped, 'link', 'links')}.` : '';
  $('import-status').textContent = problem ? `Stopped after ${sent.toLocaleString()}: ${problem}. Import again to continue. Nothing is duplicated.${refused}` : `Sent ${plural(sent, 'bookmark', 'bookmarks')} to Bookmarks.${refused}`;
});

chrome.storage.onChanged.addListener(() => void render());
void render();
