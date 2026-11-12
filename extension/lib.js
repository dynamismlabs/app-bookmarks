// Logic with no browser in it, so it can be tested on its own.
//
// The extension is an ordinary MCP client of the Bookmarks app. It connects
// with OAuth like any assistant: it registers itself, the app's consent screen
// asks the person whether it may add links, and it gets its own token. Saves
// go to the app's /mcp endpoint as calls to save_bookmarks. Nothing goes
// anywhere else.

export const MAX_PAGE_CHARS = 200_000;
export const QUEUED_PAGE_CHARS = 50_000;
export const BATCH_SIZE = 100;
/** The app takes 11 MB in one request. Stay well under, and leave room for the envelope. */
export const BATCH_BYTES = 900_000;
const LIMITS = { url: 4096, title: 2000, note: 8000, excerpt: 2000, tag: 200, tags: 50 };
export const SAVE_TOOL = 'save_bookmarks';
export const DEFAULT_APP = 'http://127.0.0.1:4316';
export const CLIENT_NAME = 'Bookmarks browser extension';
const SCOPE = 'openid profile offline_access';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The app's origin from what the person typed, or null. Plain http only on this computer. */
export function appOrigin(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = (LOOPBACK.test(text.split(/[:/]/)[0]) ? 'http://' : 'https://') + text;
  try {
    const url = new URL(text);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && LOOPBACK.test(url.hostname)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

/** The one site this extension asks to reach. Chrome's patterns match any port on that host. */
export const originPattern = (app) => `${new URL(app).protocol}//${new URL(app).hostname}/*`;
export const saveable = (url) => /^https?:\/\//i.test(String(url ?? ''));

/** Folder names browsers make for you, which say nothing about the links inside. */
const ROOT_FOLDERS = new Set([
  '', 'bookmarks', 'bookmarks bar', 'bookmarks toolbar', 'bookmarks menu', 'favorites', 'favorites bar', 'favourites', 'favourites bar',
  'other bookmarks', 'other favorites', 'mobile bookmarks', 'synced bookmarks', 'imported', 'unsorted', 'menu', 'toolbar', 'unfiled',
]);
export const tagsFromFolders = (folders) => folders.filter((name) => !ROOT_FOLDERS.has(String(name).trim().toLowerCase())).map((name) => String(name).trim()).slice(0, 20);

/**
 * Fit an item to what the app accepts, or null when its link can't be kept. One
 * odd field would otherwise make the app refuse the whole request it arrived in.
 */
export function fitItem(item) {
  if (!saveable(item.url) || item.url.length > LIMITS.url) return null;
  const fitted = { ...item };
  for (const field of ['title', 'note', 'excerpt']) if (fitted[field]) fitted[field] = fitted[field].slice(0, LIMITS[field]);
  if (fitted.tags) fitted.tags = fitted.tags.slice(0, LIMITS.tags).map((tag) => tag.slice(0, LIMITS.tag));
  if (fitted.pageText) fitted.pageText = fitted.pageText.slice(0, MAX_PAGE_CHARS);
  return fitted;
}

/** Every web link in a bookmarks tree, with its folders as tags. */
export function flattenTree(nodes, folders = []) {
  const links = [];
  for (const node of nodes) {
    if (node.url) {
      const link = fitItem({ url: node.url, title: node.title || null, savedAt: node.dateAdded ?? null, tags: tagsFromFolders(folders) });
      if (link) links.push(link);
    } else if (node.children) {
      links.push(...flattenTree(node.children, [...folders, node.title ?? '']));
    }
  }
  return links;
}

const bytesOf = (item) => new TextEncoder().encode(JSON.stringify(item)).length;

/** The most items from the start of a list that fit in one request. Always at least one. */
export function firstBatch(items) {
  let bytes = 0, count = 0;
  for (const item of items) {
    bytes += bytesOf(item);
    if (count && (count >= BATCH_SIZE || bytes > BATCH_BYTES)) break;
    count++;
  }
  return items.slice(0, count);
}
export function batches(items) {
  const out = [];
  for (let rest = items; rest.length; rest = rest.slice(out.at(-1).length)) out.push(firstBatch(rest));
  return out;
}

export const clipText = (text, max = MAX_PAGE_CHARS) => (text && text.length > max ? text.slice(0, max) : text || null);

/** What a saved item may keep while it waits in the browser's small storage. */
export const forQueue = (item) => (item.pageText ? { ...item, pageText: clipText(item.pageText, QUEUED_PAGE_CHARS) } : item);

/** Split tags typed in the popup. */
export const parseTags = (text) => String(text ?? '').split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 20);

// ─── OAuth ──────────────────────────────────────────────────────────────────

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge. */
export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function json(response) {
  return response.json().catch(() => null);
}

/** Where the app signs clients in, found the standard way: protected resource metadata, then the authorization server's. */
export async function discover(fetcher, app) {
  let resource = `${app}/mcp`, issuer = app;
  try {
    const prm = await fetcher(`${app}/.well-known/oauth-protected-resource`);
    const body = prm.ok ? await json(prm) : null;
    if (body?.resource) resource = body.resource;
    if (body?.authorization_servers?.[0]) issuer = String(body.authorization_servers[0]).replace(/\/$/, '');
  } catch {
    throw new Error(`Could not reach ${app}. Check that Bookmarks is running, then try again.`);
  }
  const response = await fetcher(`${issuer}/.well-known/oauth-authorization-server`).catch(() => null);
  const meta = response?.ok ? await json(response) : null;
  if (!meta?.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) throw new Error(`${app} doesn't look like Bookmarks. Check the address.`);
  return { resource, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, registrationEndpoint: meta.registration_endpoint, revocationEndpoint: meta.revocation_endpoint ?? null };
}

/** Register this browser as its own client, so it shows in the app's Settings as its own connection. */
export async function register(fetcher, meta, redirectUri, name = CLIENT_NAME) {
  const response = await fetcher(meta.registrationEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], software_id: 'bookmarks-extension' }),
  });
  const body = await json(response);
  if (!response.ok || !body?.client_id) throw new Error('Bookmarks refused to register this browser. Try again.');
  return body.client_id;
}

export function authorizeUrl(meta, clientId, redirectUri, challenge, state) {
  const url = new URL(meta.authorizationEndpoint);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', resource: meta.resource }).toString();
  return url.href;
}

/** The code from where the consent screen sent the browser, checked against the state this flow started with. */
export function codeFrom(redirected, state) {
  const url = new URL(redirected);
  if (url.searchParams.get('state') !== state) throw new Error('This approval was for a different request. Connect again.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error(url.searchParams.get('error_description') ?? 'You didn\'t allow the connection.');
  return code;
}

const tokensFrom = (body, now) => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token ?? null,
  expiresAt: now + Math.max(60, Number(body.expires_in ?? 3600)) * 1000,
});

export async function exchangeCode(fetcher, meta, clientId, redirectUri, code, verifier, now = Date.now()) {
  const response = await fetcher(meta.tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource: meta.resource }).toString(),
  });
  const body = await json(response);
  if (!response.ok || !body?.access_token) throw new Error('Bookmarks didn\'t finish the connection. Try again.');
  return tokensFrom(body, now);
}

/** The whole connection the extension keeps. */
export function connectionFor(app, meta, clientId, tokens) {
  return { app, clientId, tokenEndpoint: meta.tokenEndpoint, revocationEndpoint: meta.revocationEndpoint, resource: meta.resource, ...tokens };
}

// ─── Calling the app ────────────────────────────────────────────────────────

let rpcId = 0;
/**
 * One MCP tool call. `outcome` says what to do next: `ok`, `expired` (refresh
 * the token and try again), `retry` (the app can't be reached, or is busy),
 * `rejected` (this request will never work, so it must not block the queue) or
 * `disconnected` (the connection no longer works).
 */
export async function callTool(fetcher, connection, name, args) {
  let response;
  try {
    response = await fetcher(`${connection.app}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    return { outcome: 'retry', message: 'Could not reach Bookmarks' };
  }
  const body = await json(response);
  if (response.status === 401) return { outcome: 'expired', message: 'Bookmarks needs this browser to connect again' };
  if (response.status === 403) return { outcome: 'disconnected', message: body?.error ?? 'Bookmarks no longer accepts this browser' };
  if (response.status === 413) return { outcome: 'rejected', message: 'This is too large for Bookmarks to take at once' };
  if (!response.ok || !body) return { outcome: 'retry', message: body?.error ?? `Bookmarks answered ${response.status}` };
  if (body.error) return { outcome: 'rejected', message: body.error.message ?? 'Bookmarks refused this request' };
  const result = body.result ?? {};
  if (result.isError) {
    const message = result.content?.find((part) => part.type === 'text')?.text ?? 'Bookmarks refused this request';
    // A connection allowed only to read can't add links: the person has to connect again and allow changes.
    if (/can read but not make changes|unavailable/i.test(message)) return { outcome: 'disconnected', message };
    return { outcome: 'rejected', message };
  }
  return { outcome: 'ok', body: result.structuredContent?.result ?? null };
}

/**
 * The connection with its token kept fresh. `load` and `save` hold the
 * connection (chrome.storage in the extension). Refreshes run one at a time:
 * the app rotates refresh tokens and ends a connection whose old one is reused.
 */
export function createSession({ fetcher, load, save, now = () => Date.now() }) {
  let refreshing = null;
  async function refresh(connection) {
    if (!connection.refreshToken) return null;
    let response;
    try {
      response = await fetcher(connection.tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.clientId, refresh_token: connection.refreshToken, resource: connection.resource }).toString(),
      });
    } catch {
      return 'retry';
    }
    const body = await json(response);
    if (response.status >= 500) return 'retry';
    if (!response.ok || !body?.access_token) return null;
    const next = { ...connection, ...tokensFrom(body, now()), refreshToken: body.refresh_token ?? connection.refreshToken };
    await save(next);
    return next;
  }
  /** A connection with a current token, `retry` when the app can't be reached, or null when it must connect again. */
  async function fresh(force = false) {
    const connection = await load();
    if (!connection) return null;
    if (!force && connection.expiresAt > now() + 30_000) return connection;
    refreshing ??= refresh(connection).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function call(name, args) {
    let connection = await fresh();
    if (connection === 'retry') return { outcome: 'retry', message: 'Could not reach Bookmarks' };
    if (!connection) return { outcome: 'disconnected', message: 'Connect this browser to Bookmarks again' };
    let result = await callTool(fetcher, connection, name, args);
    if (result.outcome !== 'expired') return result;
    connection = await fresh(true);
    if (connection === 'retry') return { outcome: 'retry', message: 'Could not reach Bookmarks' };
    if (!connection) return { outcome: 'disconnected', message: 'Bookmarks needs this browser to connect again' };
    result = await callTool(fetcher, connection, name, args);
    return result.outcome === 'expired' ? { outcome: 'disconnected', message: result.message } : result;
  }
  return { call, fresh };
}

/**
 * Send items, keeping every one the app will take. If it refuses a request, it
 * might be over one item, so they go one at a time and only that item is dropped.
 * `done` counts the items from the start that need no more attention.
 */
export async function sendItems(session, via, items) {
  const result = await session.call(SAVE_TOOL, { via, items });
  if (result.outcome === 'ok') return { outcome: 'ok', done: items.length, dropped: 0, invalid: result.body?.invalid ?? 0, message: null };
  if (result.outcome !== 'rejected') return { outcome: result.outcome, done: 0, dropped: 0, invalid: 0, message: result.message };
  if (items.length === 1) return { outcome: 'ok', done: 1, dropped: 1, invalid: 0, message: result.message };
  let done = 0, dropped = 0, invalid = 0, message = null;
  for (const item of items) {
    const single = await sendItems(session, via, [item]);
    if (single.outcome !== 'ok') return { ...single, done, dropped, invalid };
    done++;
    dropped += single.dropped;
    invalid += single.invalid;
    message = single.message ?? message;
  }
  return { outcome: 'ok', done, dropped, invalid, message };
}
