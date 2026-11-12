// Copies normal bookmarks to Bookmarks, saves the tab when asked, and keeps
// anything unsent until the app answers. All calls to the app happen here, so
// one place keeps the token fresh.
import {
  authorizeUrl, clipText, codeFrom, connectionFor, discover, exchangeCode, firstBatch, fitItem, forQueue, pkcePair, register,
  saveable, SAVE_TOOL, sendItems, createSession, tagsFromFolders,
} from './lib.js';

const MAX_QUEUE = 5000;
let chain = Promise.resolve();
/** Storage writes read first, so they run one at a time. */
const serial = (work) => (chain = chain.then(work, work));

const stored = (keys) => chrome.storage.local.get(keys);
const session = createSession({
  fetcher: (url, init) => fetch(url, init),
  load: async () => (await stored('connection')).connection ?? null,
  save: (connection) => serial(() => chrome.storage.local.set({ connection })),
});

async function folderNames(parentId) {
  const names = [];
  for (let id = parentId; id; ) {
    const [node] = await chrome.bookmarks.get(id).catch(() => []);
    if (!node) break;
    names.unshift(node.title ?? '');
    id = node.parentId;
  }
  return names;
}

function enqueue(items) {
  const fitted = items.map(fitItem).filter(Boolean).map((item) => ({ ...forQueue(item), queueId: crypto.randomUUID() }));
  return serial(async () => {
    const { queue = [] } = await stored('queue');
    await chrome.storage.local.set({ queue: [...queue, ...fitted].slice(-MAX_QUEUE) });
  });
}

async function showState(state) {
  await chrome.action.setBadgeBackgroundColor({ color: '#a8443b' });
  await chrome.action.setBadgeText({ text: state === 'disconnected' ? '!' : '' });
}

async function markDisconnected(message) {
  await chrome.storage.local.set({ lastError: message, disconnected: true });
  await showState('disconnected');
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const { connection, queue = [], disconnected } = await stored(['connection', 'queue', 'disconnected']);
      if (!connection || disconnected || !queue.length) return;
      const via = queue[0].via;
      const end = queue.findIndex((item) => item.via !== via);
      const strip = ({ via: _via, queueId: _queueId, ...item }) => item;
      const batch = firstBatch((end < 0 ? queue : queue.slice(0, end)));
      const result = await sendItems(session, via, batch.map(strip));
      const finished = new Set(batch.slice(0, result.done).map((item) => item.queueId));
      if (finished.size) {
        await serial(async () => {
          const { queue: current = [] } = await stored('queue');
          await chrome.storage.local.set({ queue: current.filter((item) => !finished.has(item.queueId)) });
        });
      }
      if (result.outcome === 'retry') return;
      if (result.outcome === 'disconnected') return markDisconnected(result.message);
      await chrome.storage.local.set({ lastError: result.dropped ? result.message : null, disconnected: false });
      await showState('ok');
    }
  } finally {
    flushing = false;
  }
}

/** Runs inside the page, so it sees what you see, including behind a login. */
function readPage() {
  const article = [...document.querySelectorAll('article, main')].map((node) => node.innerText ?? '').sort((a, b) => b.length - a.length)[0] ?? '';
  const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content ?? null;
  return { text: article.length >= 280 ? article : document.body?.innerText ?? '', description, selection: String(getSelection()) };
}

async function pageContent(tabId) {
  try {
    const [injected] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    return injected?.result ?? null;
  } catch {
    // The browser's own pages, the store and file viewers refuse scripts. The link still saves.
    return null;
  }
}

/** Saves the tab here, not in the popup, because clicking back on the page closes the popup and would cancel it. */
async function saveTab(tab) {
  const content = await pageContent(tab.id);
  const item = fitItem({ url: tab.url, title: tab.title || null, excerpt: content?.description || null, pageText: clipText(content?.text?.trim()) });
  if (!item) return { outcome: 'rejected', message: 'This link is too long to save.' };
  const result = await session.call(SAVE_TOOL, { via: 'extension', items: [item] });
  if (result.outcome === 'retry') await enqueue([{ via: 'extension', ...item }]);
  if (result.outcome === 'disconnected') await markDisconnected(result.message);
  return { outcome: result.outcome, message: result.message ?? null, invalid: !!result.body?.invalid, hasText: !!content?.text?.trim(), selection: content?.selection?.trim().slice(0, 4000) ?? '' };
}

/**
 * Connect with OAuth, the way any assistant connects: register this browser,
 * open the app's consent screen, and keep the token it gives. The person sees
 * who is asking and allows adding links.
 */
async function connect(app) {
  const fetcher = (url, init) => fetch(url, init);
  const meta = await discover(fetcher, app);
  const redirectUri = chrome.identity.getRedirectURL('bookmarks');
  const browser = navigator.userAgentData?.platform ? ` on ${navigator.userAgentData.platform}` : '';
  const clientId = await register(fetcher, meta, redirectUri, `Bookmarks browser extension${browser}`);
  const { verifier, challenge } = await pkcePair();
  const state = crypto.randomUUID();
  const redirected = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl(meta, clientId, redirectUri, challenge, state), interactive: true })
    .catch(() => { throw new Error('The connection window closed before you allowed it.'); });
  const tokens = await exchangeCode(fetcher, meta, clientId, redirectUri, codeFrom(redirected, state), verifier);
  const connection = connectionFor(app, meta, clientId, tokens);
  await serial(() => chrome.storage.local.set({ connection, mirror: true, disconnected: false, lastError: null }));
  // Check it can add links: a connection allowed only to read gets an error here.
  const check = await session.call(SAVE_TOOL, { via: 'extension', items: [] });
  if (check.outcome === 'disconnected') {
    await serial(() => chrome.storage.local.remove(['connection']));
    throw new Error('Bookmarks connected this browser to read only. Connect again and allow it to add and change records.');
  }
  await showState('ok');
  void flush();
  return { ok: true };
}

async function disconnect() {
  const { connection } = await stored('connection');
  if (connection?.revocationEndpoint && connection.refreshToken) {
    await fetch(connection.revocationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: connection.refreshToken, token_type_hint: 'refresh_token', client_id: connection.clientId }).toString(),
    }).catch(() => undefined);
  }
  await serial(() => chrome.storage.local.remove(['connection', 'disconnected', 'lastError']));
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

chrome.bookmarks.onCreated.addListener(async (_id, node) => {
  if (!saveable(node.url)) return;
  const { connection, mirror = true } = await stored(['connection', 'mirror']);
  if (!connection || !mirror) return;
  await enqueue([{ via: 'bookmark', url: node.url, title: node.title || null, savedAt: node.dateAdded ?? null, tags: tagsFromFolders(await folderNames(node.parentId)) }]);
  await flush();
});

const handlers = {
  'save-tab': (message) => saveTab(message.tab),
  queue: (message) => enqueue(message.items).then(flush).then(() => ({ ok: true })),
  flush: () => flush().then(() => ({ ok: true })),
  // The options page imports in batches through here, so the token stays in one place.
  send: (message) => sendItems(session, message.via, message.items).then(async (result) => {
    if (result.outcome === 'disconnected') await markDisconnected(result.message);
    return result;
  }),
  connect: (message) => connect(message.app).catch((error) => ({ ok: false, message: error.message })),
  disconnect: () => disconnect(),
};
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(reply, (error) => reply({ outcome: 'rejected', ok: false, message: error?.message ?? 'This could not be done.' }));
  return true;
});

// The worker restarts often, and creating an alarm again would push it back every time.
chrome.alarms.get('flush').then((alarm) => { if (!alarm) chrome.alarms.create('flush', { periodInMinutes: 5 }); });
chrome.alarms.onAlarm.addListener(() => void flush());
chrome.runtime.onStartup.addListener(() => void flush());
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.runtime.openOptionsPage();
});
