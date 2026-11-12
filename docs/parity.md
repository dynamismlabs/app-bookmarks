# Bookmarks: parity with the app that was built into Ri

Ri's Bookmarks app (`apps/bookmarks` at Ri commit `3c442810`) is ported here onto App Builder (core 0.2.0). This checklist covers every feature and behavior in the old README, AGENTS.md, plugin.json, contract and tests, including the browser extension.

- **Works**: the same behavior, on the new path.
- **Works differently**: the person or an assistant can still do it, in another way (says how).
- **Can't work yet**: not possible on the new path as built (says why, and what would need to change in the kit or Ri).

Checked on November 12, 2026, against kit `main` at `bc2c7f4`, with Ri's hub as read on Ri branch `claude/single-path-ri-approval-id`. Ri itself wasn't run: a later session checks the ported apps inside Ri.

## In short

- **Works**: saving, merging repeats, search over page text, tags, editing with revision checks, deleting, imports and export, the bookmarklet, saving from any assistant, reading pages in the background through Ri, read-only or read-and-write access per connection, a card in the chat and the whole app in Ri.
- **Works differently**: the extension and every assistant connect with OAuth instead of a Ri key, so each browser shows up in Settings like any assistant. Reading pages is turned on by connecting Bookmarks to Ri and allowing "Read public web pages". Deleting, importing and exporting happen in Bookmarks' own page, not inside Ri. The context handed to a chat is the selected link's id and title, and the model reads the rest with `get_bookmark`. The demo is `pnpm preview`.
- **Can't work yet**:
  1. **The extension can't sign in.** Chrome sends the extension's origin on its registration and token requests, and the kit answers 403 to any other origin except on `/mcp`. Everything after sign-in works in Chromium. Needs a one-line kit change (below).
  2. **"Add links and nothing else."** The old extension and Shortcut keys could only add. A kit connection can read, or read and write. Needs an add-only choice in the kit's consent screen.
  3. **The iPhone Shortcut from a Mac-local app.** The phone can't reach `127.0.0.1`, and Ri's remote address shows apps' views, not their pages. Works when Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in).
  4. **Opening a saved link from the view inside Ri.** The kit's view client has no `ui/open-link`, and the sandbox blocks new windows. The view offers to copy the link.
  5. **Opening the view at one record (deep links) and Ri's record entities.** `open_bookmarks` takes no input, and the kit has no entity registry. `show_bookmarks` with `ids` shows exactly the links meant.

## Finding and keeping links

| Feature | Status | How, or why not |
| --- | --- | --- |
| Search first, then links newest first | Works | `list_bookmarks` and the library screen. |
| Search covers titles, links, notes, tags and saved page text, title counting most | Works | SQLite FTS5 with the same bm25 weights (title 10, tags 8, note 6, link 3, body 1). Test: "searches page text, titles, links, notes and tags". |
| Every word required, prefix matching, search syntax treated as plain words | Works | Same `ftsQuery`. Test: "needs every word, and treats search syntax as plain words". |
| Matching passage shown, search words marked | Works | `snippet` from FTS, `Marked` in the screens and the card. |
| Filter by tag, tags most used first with counts | Works | `list_tags`, tag chips. Test: "filters by tag and pages newest first". |
| Paging with cursors (search and newest) | Works | Same cursor shapes. |
| "Search can't yet cover everything" note while pages wait | Works | `coverage` on `list_bookmarks`. Test: "says when search can't yet cover everything". |
| Selecting a link shows its note, tags and what the page said | Works | The inspector, with "What the page said". |
| One page saved twice is one record (case, trailing slash, default port, fragments and tracking parameters ignored) | Works | Same `parseLink`/`url_key`, now unique per person. Tests in `domain.test.ts` and "makes one record for one page". |
| A repeat adds tags and never overwrites a title or note the person wrote | Works | Same `TITLE_RANK` merge. Tests: "never lets a save overwrite a title the owner chose", "treats a title as edited only when it changed". |
| A repeat keeps the earliest date and doesn't jump to the top | Works | Test: "keeps the earliest date". |
| Only http and https links, no passwords in links, bounded length | Works | Same validation. |
| Edit title, note, tags with a revision check, conflict returns the current record | Works | `update_bookmark` with `expectedRevision`. |
| A retried write returns its first result (Ri replayed by invocation ID) | Works differently | The kit has no invocation replay. Saves are idempotent by link, so a retried save returns the same record. A retried edit after it already applied answers "conflict" with the current record, which shows the change. Test: "keeps a retried save as one record". |
| Two saves of the same page at the same moment | Works | Every write is guarded by a write token and merges on a lost race. New test: "keeps one record when the same page is saved twice at the same moment". |
| Delete a link with its note, tags, page text and search row | Works | Triggers remove tags and the search row. Test: "deletes a link with its text and search row". |
| Deleting stays with the owner | Works differently | `delete_bookmark` is for the person's own browser only (`audience: ["user"]`). No assistant can delete. Inside Ri's view the person can't delete either, because the view can only call tools the model can also call; the view says to delete in Bookmarks itself. To offer it in the view, the kit would need app-only tools that the app can tell apart from the model's calls (MCP Apps' `visibility: ["app"]` is presentation only, so it can't carry the security). |
| The editor never overwrites what someone is typing, and keeps it through a conflict | Works | The inspector fills its form once and keeps typed values on conflict. Not covered by an automated browser test here (the old `view.test.ts` screenshot suite wasn't ported). |
| Records survive a restart | Works | Test: "keeps saved links and their text through a restart". |
| Each person's links are their own | Works (new) | The old app had one owner. The kit allows several accounts, so every query is by person. Test: "keeps each person's links to themselves". |

## Ways in

| Path | Status | How, or why not |
| --- | --- | --- |
| Chat: an assistant calls `save_bookmark` | Works | Any connection allowed to make changes. Its saves are labeled "Saved by an assistant" (`via: "chat"`), whatever it passes. Saves made by the person inside Ri's view get that label too, since the app can't tell the person from the model on one connection. |
| File: browser HTML, Raindrop HTML or CSV, any CSV with a url column, pasted links | Works | Same parsers. Upload in parts, preview, apply once. In Bookmarks' own page (Import), not in Ri's view. Tests: the "import" group, including 20,000 links in one apply (now a few seconds, in batched transactions). |
| Preview before anything changes, apply exactly once, refuse a wrong digest, an expired preview or an unfinished upload | Works | Tests: "previews without changing anything", "refuses a wrong digest". |
| File encodings: UTF-8, UTF-16, Windows-1252, favicons dropped | Works | `readSelectedFile` now takes the file's bytes from the page. Ri's file picker (`files.select`) is replaced by an ordinary file input. |
| Bookmarklet: a small window that saves the page | Works differently | Opens Bookmarks' own `/save` page, using the browser's sign-in to Bookmarks (or local-owner mode on this computer) instead of Ri's. Saves once, then lets the person add tags and a note. Verified in a browser against the running service: one record, labeled bookmarklet, a reload saves nothing. It holds no key. |
| iPhone Shortcut: the share sheet saves the link | Can't work yet for an app on the Mac. Works differently where the phone can reach the app | The Shortcut used to post to Ri's remote address with a key. A Mac-local app is only at `127.0.0.1`, and Ri's remote address shows apps' views, not their pages or tools (shared spec, open question 2). The Connect page says so. When Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in), the Shortcut opens `/save?via=shortcut&url=…` in Safari, where the person is signed in. To work from a Mac-local app: Ri's remote address would need to reach the app's pages, or offer a save that calls the app's `save_bookmark` through Ri's own connection. |
| Extension, Cmd+D copies the bookmark | Works once connected. Connecting can't work yet | See the extension section. |
| Extension, toolbar button or Alt+Shift+S saves the tab with the text you can see | Works once connected | Real-Chromium test: "saves the tab with the text you can see". |
| Extension, Import copies everything in the browser, folders as tags | Works once connected | Real-Chromium test: "imports every bookmark in batches". |

## The browser extension

The extension is now an ordinary OAuth MCP client of Bookmarks: it registers itself, opens Bookmarks' consent screen with `chrome.identity.launchWebAuthFlow`, keeps its own refresh token and calls `save_bookmarks` on `/mcp`. It saves to Bookmarks' own server and nowhere else.

| Feature | Status | How, or why not |
| --- | --- | --- |
| Connect this browser | **Can't work yet** | Measured in Chromium 1223 against the built app: `POST /api/auth/mcp/register` and `POST /api/auth/mcp/token` answer **403 "Open this request from the app."**, because Chrome sends `Origin: chrome-extension://<id>` and the kit's server only lets another origin through on `/mcp` with a token. The extension now says Bookmarks needs an update. **Kit change:** let another origin through on OAuth's client endpoints (`/api/auth/mcp/register`, `/api/auth/mcp/token`, and a revocation endpoint if added). They carry no cookie authority: registration makes a client, and the token endpoint needs a code with its PKCE verifier, or a refresh token. Authorize and consent stay same-origin. Pinned by "is refused today when it signs in from inside the browser" in `tests/extension.test.ts`, which fails once the kit changes. The rest of the flow passes from Node (register, consent, code, token, save, refresh, a read-only grant, disconnect in Settings). |
| Refresh an expired token | **Can't work yet** | Same 403 on the token endpoint from inside the browser. The real-Chromium test proves the same refresh token works from outside the browser. Today a connected extension would ask to connect again after an hour. Fixed by the same kit change. |
| "The key can add links and nothing else" | **Can't work yet** | A kit connection can read, or read and write. The extension needs write, so its connection could also read every bookmark. `save_bookmarks` still answers only counts. **Kit change:** an optional "add only" choice on the consent screen (or per-tool scopes), enforced like `write`. |
| Pasted connection code shown once | Works differently | No code or key. The person enters Bookmarks' address and allows the browser on the consent screen. |
| Everything connected, and a way to remove it | Works differently | Each browser is its own OAuth connection, listed in Settings with every assistant ("Bookmarks browser extension on macOS"), with Disconnect. Test: "lists each connected browser in Settings". |
| Disconnect from the extension | Works differently | The extension forgets its token. The kit's authorization server offers no revocation endpoint, so the connection stays listed in Settings until the person disconnects it there or its refresh token lapses. **Kit change:** an RFC 7009 revocation endpoint. |
| Asks for no site access up front, only the app's own host at Connect | Works | Optional host permission for the one host. Test: "asks for no site access up front". Adds `identity` for the sign-in window. |
| Cmd+D mirroring, folders as tags, ignores folders, browser pages and everything while switched off | Works once connected | Real-Chromium tests. |
| Keeps links while the app is away and sends them when it answers, losing nothing | Works once connected | Real-Chromium test, and unit tests of the queue. |
| Says when its connection stops working, keeps what it couldn't send, badge "!" | Works | Real-Chromium test: "says when its connection stops working". |
| One refused link doesn't block the ones behind it, batches stay under the size limit in any script | Works | Unit tests in `tests/extension.test.ts`. |
| The toolbar save finishes when the popup closes, saves the link when the page refuses to be read | Works | The background worker saves. Not separately browser-tested here. |
| Import isn't stopped by an enormous address, stops cleanly and says how far it got | Works | `fitItem` unit test. The stop message is in the options page. |
| Refresh tokens rotate (kit fix in progress) | Works | Refreshes run one at a time and the new refresh token is stored before the next. Unit test: "refreshes one at a time". |
| The app offers the extension as a zip, and the zip matches the folder | Works | `/connect` downloads it (`get_extension_package`, the person only). Tests: "embeds exactly what is in the folder". |
| Loads in Chromium from the zip the app offers | Works | The real-Chromium tests unzip the offered package. |
| Chrome Web Store listing (`docs/chrome-web-store.md`) | Not carried over | It was Ri-branded, and publishing waits until the extension can sign in. |

## Reading pages

| Feature | Status | How, or why not |
| --- | --- | --- |
| A link with no page text waits to be read | Works | |
| Settings says what Bookmarks asks Ri for | Works differently | The kit's "Your accounts through Ri" section words a request only by capability (mail, calendar). Bookmarks asks for a tool, so it reads "asks Ri to use your accounts, to read the pages you save". Ri's own consent screen names it correctly ("Read public web pages"). **Kit change:** name requested tools in that sentence. |
| Turned on in the app's Sources dialog | Works differently | Connect Bookmarks to Ri in Settings ("Your accounts through Ri") and allow "Read public web pages" on Ri's consent screen. Bookmarks declares `connectors.tools: ["ri__read_web_page"]` with its purpose. Until then the screen says to connect Ri, and the job fails with what to do. |
| Every five minutes, one bounded step | Works differently | A declared job, `read_pages`, "every 5 minutes", run by the app's own runner (no Ri clock). Settings shows its schedule, last run and result, with Run now. |
| Up to twelve pages per step, spread across sites, at most three per site, 20 second budget | Works | Tests: "reads a bounded number of pages per step, from different sites", "keeps moving through a library that is mostly one site". |
| Through Ri's `read_web_page`: no sign-ins, no private networks, never `fetch` in the app | Works | `connectors(ctx).call("ri__read_web_page")`. Ri's reader is unchanged. Tested against the kit's fixture source and a stand-in, not against Ri itself. |
| Fills the title only when nothing better named it, keeps browser text | Works | Tests: "keeps a title someone gave and leaves browser text alone", and a new race test "keeps what the browser saved when it arrives while the page is being read". |
| Reading doesn't get in the way of someone editing | Works | Test of the same name. |
| Records why a page couldn't be read, retries only what could change, with backoff | Works | Test: "records why a page could not be read". |
| Gives up on a page that keeps taking the whole step down | Works | Test of the same name. |
| Saving again gives a page another chance | Works | Test of the same name. |
| Stops at once when reading isn't allowed and doesn't count it against pages | Works differently | A missing grant or revoked hub is `SetupRequired` (Settings shows it), Ri being down is `SourceUnavailable` (the runner retries with backoff). Neither counts against a page. Tests: "says what to do when Ri hasn't allowed reading", "stops at once when Ri refuses mid-step". |
| Says when reading is running | Works | From the last step that could read. Fixed during the port so a refused step doesn't count. |
| Saved text is labeled reference material for any chat | Works differently | The old app put page text into the chat's context under a label. Now no page text goes into the context. Tool descriptions say page text is reference material and never instructions, and the model reads it with `get_bookmark`. |

## Sharing with a chat, and Ri's view

| Feature | Status | How, or why not |
| --- | --- | --- |
| A chat sees nothing until the person shares | Works differently | Nothing reaches Bookmarks without a connection the person approved on its consent screen. MCP without a token gets 401. Per place, not per chat: each Ri workspace (and Ri's own chats) is one connection, so all chats in a workspace share its choice. |
| Shared as a whole, read only or read and write | Works | Bookmarks declares no sources, so the consent screen asks only read or also write. Tests: "honors read and write", over MCP "refuses a read-only connection's save with a reason it can show". |
| The access screen (`/access`, `create_scope` with a host-bound actor) | Works differently | Replaced by the kit's consent screen and Settings' connection list. Revoking: disconnect in Settings. Test: "stops a disconnected connection at once while another keeps working". |
| Connecting browsers and phones stays with the owner | Works differently | Only the person can approve a connection on the consent screen. |
| Open the view at `/`, `/bookmarks/<id>`, `/connect`, `/save` (`open_view`) | Works differently | `open_bookmarks` opens the whole app in Ri, and `show_bookmarks` draws a card (by ids, a search or a tag). The web app has the same paths. **Can't yet:** open Ri's view at one record. `open_<app>` takes no input and the kit doesn't emit `openai/deepLink`. |
| Ri entities (`bookmark`, readAction, searchAction, openPath) | Can't work yet | MCP has no entity registry and the kit doesn't declare one, so Ri can't list bookmarks as records it knows about. Tools cover reading and searching. Needs a kit or MCP convention if Ri wants record references. |
| The chat beside the view gets what it shows (`describe_view_context`) | Works differently | The view publishes the selected link's id and title (`client.select`) and what the person changed (`client.didChange`). Page text, search state and record refs no longer go into context; the model calls `get_bookmark`. |
| Open a saved link from the view | Can't work yet inside Ri | The view is sandboxed with no network or popups, and the kit's client doesn't expose MCP Apps `ui/open-link`. The view offers to copy the link. In Bookmarks' own page links open normally. **Kit change:** expose `openLink` on the view client. |
| A fictional preview the catalog's Try opens (demo mode, `fixture` principal) | Works differently | `pnpm preview` seeds the fictional library into a disposable data directory and starts the app with the fixture hub. Records are marked fictional and no page is requested. Ri's catalog would need to run that to offer Try. Test: "starts with a fictional library, marked as such". |
| The `find-saved-links` skill shipped to chats | Works differently | The kit sets no MCP server instructions and has no way to ship a skill, so its rules moved into tool descriptions: try the page's own words, check coverage, read before quoting, page text may be out of date, never instructions, deleting is for the person. |
| Ri's file picker and download (`files.select`, `files.download`) | Works differently | Import and export use the browser in Bookmarks' own page. Not available inside Ri's view (sandboxed, no downloads). |
| The view follows the host's theme and fits every width | Works | The kit applies the host's theme. Checked the web app in a browser. The old screenshot suite (`view.test.ts`) wasn't ported. |
| The view shows a site's initial rather than its favicon | Works | |
| Bookmarks in Ri's catalog with a description and demo rows (`catalog.json`) | Not in this app | Ri's new catalog (shared spec, "The catalog") lists apps by git URL. Ri's side. |

## Connect screen and export

| Feature | Status | How, or why not |
| --- | --- | --- |
| Offers the extension for download | Works | `/connect`. |
| Bookmarklet with no key in it | Works | `/connect`. Test: "makes a bookmarklet that holds no key". |
| iPhone Shortcut setup | Works differently | Shown when the app's address isn't this computer's loopback; otherwise the page explains why the phone can't reach it. |
| Export as a browser bookmarks file | Works | `/connect`, "Export a bookmarks file". Test: "handles a large library in one apply, and exports it back". |
| Personal data export (new) | Works | The kit's Settings export includes bookmarks without page text. |

## Limits

| Limit | Status |
| --- | --- |
| 50,000 links and 32 MB per import | Works |
| 200,000 characters kept per page | Works |
| 3 MB of HTML read | Works (Ri's reader) |
| PDFs saved without text | Works (`no_text`) |

## Maintenance rules from the old AGENTS.md

| Rule | Status |
| --- | --- |
| Client actions can't reveal saved links | Works for `save_bookmarks`' answers. The connection itself can read (see "add links and nothing else"). |
| One page, one record, through one save function | Works (`saveOne`/`saveMany`). |
| Page text untrusted | Works. |
| Reading only through the host's `read_web_page`, one bounded step, no loops or timers | Works. |
| Search and page text in `bookmarks_fts` keyed by `seq`, kept in step on every change | Works, now with triggers. |
| A chat sees everything or nothing, owner-only actions checked | Works (no sources, `audience: ["user"]`). |
| Forward-only migrations, policy values in the query layer | Works (kit migrations, checksum-checked). |
| Copy without long dashes or semicolons | Works (contract and extension tests). |
| `run_background_step` reachable only by the schedule | Works. `read_saved_pages` has no audience: only the job runner runs it. Test: "lets nobody call the reading step but the job runner". |

## What the kit or Ri would need to change

1. **Kit: accept another origin on OAuth's client endpoints** (register, token). Unblocks the extension, and any in-browser MCP client.
2. **Kit: an add-only connection choice** (or per-tool scopes) on the consent screen, enforced like `write`.
3. **Kit: a revocation endpoint** in the authorization server, so a client can disconnect itself.
4. **Kit: `openLink` on the view client** (MCP Apps `ui/open-link`).
5. **Kit: app-only tools** the app can tell from the model's calls, if deleting and importing should work inside a host's view. Optional `_meta` visibility alone isn't enough, since it carries no security.
6. **Kit: input on `open_<app>` or a deep-link convention**, to open the view at one record.
7. **Kit: MCP server instructions**, so an app can tell assistants how to use it beyond tool descriptions.
8. **Kit: name requested hub tools in Settings**, not only capabilities.
9. **Ri: reach a local app from the phone** (its remote address showing app pages, or a save relayed through Ri's own connection), for the iPhone Shortcut. Shared spec open question 2.

## Verified

- `pnpm typecheck`, `pnpm test` (vitest: domain, workflow, contract, MCP with the official SDK client, extension logic and its OAuth flow) and `pnpm build`.
- `pnpm test:browser`: the extension unzipped from the app's own package, in Playwright's Chromium 1223, against the real app.
- `app-builder serve --install --service process` on a disposable data directory: install, typecheck, test, build, rehearse and switch all passed, and no launchd agent was written.
- An MCP client using the official SDK's `auth()` against the running service: 401 challenge, discovery, dynamic registration, PKCE, the consent screen, token, tools (`save_bookmark`, `list_bookmarks`, `show_bookmarks`, the view resource) and a refresh.
- The web app in a browser against the running service: the library, the inspector, and the bookmarklet's save page saving once.
- Hub features against the kit's fixture source (`fixtureSource`, `fixtures/connectors.json`) and a stand-in that answers per address. Not against Ri's real hub.
- Not done here: Ri itself, Claude or ChatGPT drawing the view, Cloudflare (FTS5, triggers and window functions on D1 aren't verified), and a real Cmd+D keystroke.
