# Bookmarks: parity with the app that was built into Ri

Ri's Bookmarks app (`apps/bookmarks` at Ri commit `3c442810`) is ported here onto App Builder (core 0.2.2, kit `main` at `1713f6a`). This checklist covers every feature and behavior in the old README, AGENTS.md, plugin.json, contract and tests, including the browser extension.

- **Works**: the same behavior, on the new path.
- **Works differently**: the person or an assistant can still do it, in another way (says how).
- **Can't work yet**: not possible on the new path as built (says why, and what would need to change in the kit or Ri).
- **Verified in the test host**: checked in the kit's strict MCP Apps test host (a scripts-only sandbox that may not reach the network and behaves like Ri: it keeps view-only tools from its model, drafts `ui/message`, records links and downloads, and sends deep links). **In Ri**: then checked on November 16, 2026 in a disposable Ri at f55cdf96 on this Mac, on the web and in its desktop app, with dummy links only (not Trey's own Ri, which runs on another computer). ChatGPT and Claude are still pending. Details in [Real hosts](#real-hosts), screenshots in `docs/parity/`.

First checked on November 12, 2026, against kit `bc2c7f4`, with Ri's hub as read on Ri branch `claude/single-path-ri-approval-id`. Moved onto kit `1713f6a` (core 0.2.2, the full app in every host, shared spec §5) on November 16. Ri itself wasn't run.

## In short

- **Works**: saving, merging repeats, search over page text, tags, editing with revision checks, deleting, imports and export, the bookmarklet, saving from any assistant, reading pages in the background through Ri, read-only or read-and-write access per connection, a card in the chat and the whole app in Ri.
- **Now the whole app inside a host** (verified in the test host, and in a disposable Ri at f55cdf96 on the web and desktop. ChatGPT and Claude pending): deleting, importing, exporting and the extension download work in the view, kept from the model as view-only actions. Links open through the host, "Ask about this link" drafts a message, files save through the host, `open_bookmarks` opens at a link or a search, the @ menu offers saved links, the assistant hears the section, search and tag, and Open in browser covers the rest.
- **Works differently**: the extension and every assistant connect with OAuth instead of a Ri key, so each browser shows up in Settings like any assistant. Reading pages is turned on by connecting Bookmarks to Ri and allowing "Read public web pages". The demo is `pnpm preview`.
- **Can't work yet**:
  1. **The extension can't sign in.** Chrome sends the extension's origin on its registration and token requests, and the kit answers 403 to any other origin except on `/mcp`. Everything after sign-in works in Chromium. Kit gap, still open on `1713f6a`.
  2. **"Add links and nothing else."** The old extension and Shortcut keys could only add. A kit connection can read, or read and write. Kit gap: needs an add-only choice on the consent screen.
  3. **The iPhone Shortcut from a Mac-local app.** The phone can't reach `127.0.0.1`. A reachability question, not a host one: it works when Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in).
  4. **Restoring a backup.** The kit's portable backup copies the FTS5 search table's internal tables, and restore refuses them. Kit gap, pinned by a test.
  5. **Settings inside a host.** The kit's Settings (connections, the Ri connection, the reading job) uses the app's own web routes, not tools, so inside a host it opens in the browser. Kit gap.

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
| Deleting stays with the owner | Works, in the view too | `delete_bookmark` is view-only (`visibility: ["app"]`): the view offers it, and a host that follows MCP Apps keeps it from the model and refuses the model's call. **Verified in the test host, and in Ri:** the model's path got "This tool is not available to this caller." for `delete_bookmark` and `export_bookmarks`, while the view's own delete, import and export went through. ChatGPT and Claude pending. This is the host's rule, as MCP Apps defines it, not a check the app can make: the view and the model share one connection. Ri enforces it. In a host that ignored it, a connection allowed to make changes could delete. A read-only connection can't, in any host. Tests: "honors read and write, and marks deleting…", and the test host's "the model never sees the person's own actions". |
| The editor never overwrites what someone is typing, and keeps it through a conflict | Works | The inspector fills its form once and keeps typed values on conflict. Not covered by an automated browser test here (the old `view.test.ts` screenshot suite wasn't ported). |
| Records survive a restart | Works | Test: "keeps saved links and their text through a restart". |
| Each person's links are their own | Works (new) | The old app had one owner. The kit allows several accounts, so every query is by person. Test: "keeps each person's links to themselves". |

## Ways in

| Path | Status | How, or why not |
| --- | --- | --- |
| Chat: an assistant calls `save_bookmark` | Works | Any connection allowed to make changes. Its saves are labeled "Saved by an assistant" (`via: "chat"`), whatever it passes. Saves made by the person inside Ri's view get that label too, since the app can't tell the person from the model on one connection. |
| File: browser HTML, Raindrop HTML or CSV, any CSV with a url column, pasted links | Works, in the view too | Same parsers. Upload in parts, preview, apply once. The import actions are view-only, so Import works in the view as in the browser. Pasted links: verified in the test host. Choosing a file in a host's frame depends on what the host's frame allows (shared spec, "What each host allows"). **In Ri** (web and desktop) the file chooser opened from the sandboxed frame, and a dummy CSV previewed and imported. ChatGPT and Claude pending. Tests: the "import" group, including 20,000 links in one apply. |
| Preview before anything changes, apply exactly once, refuse a wrong digest, an expired preview or an unfinished upload | Works | Tests: "previews without changing anything", "refuses a wrong digest". |
| File encodings: UTF-8, UTF-16, Windows-1252, favicons dropped | Works | `readSelectedFile` now takes the file's bytes from the page. Ri's file picker (`files.select`) is replaced by an ordinary file input. |
| Bookmarklet: a small window that saves the page | Works differently | Set up from Bookmarks in the browser: a link can't be dragged out of a host's frame into the browser's bookmarks bar (the host's frame), so the view's Connect page offers Open in browser. It opens Bookmarks' own `/save` page, using the browser's sign-in to Bookmarks (or local-owner mode on this computer) instead of Ri's. Saves once, then lets the person add tags and a note. Verified in a browser against the running service: one record, labeled bookmarklet, a reload saves nothing. It holds no key. |
| iPhone Shortcut: the share sheet saves the link | Can't work yet for an app on the Mac. Works differently where the phone can reach the app | A reachability question, not a host one. The Shortcut used to post to Ri's remote address with a key. A Mac-local app is only at `127.0.0.1`, and Ri's remote address shows apps' views, not their pages or tools (shared spec, open question 2). The Connect page says so. When Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in), the Shortcut opens `/save?via=shortcut&url=…` in Safari, where the person is signed in. To work from a Mac-local app: Ri's remote address would need to reach the app's pages, or offer a save that calls the app's `save_bookmark` through Ri's own connection. |
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
| The app offers the extension as a zip, and the zip matches the folder | Works, in the view too | `/connect` saves it with `client.download`: a browser download, or the host's `ui/download-file` with the zip embedded. `get_extension_package` is view-only. Verified in the test host. Ri saves files since dynamismlabs/ri#2 (the export was checked there, not the zip). ChatGPT and Claude pending. Tests: "embeds exactly what is in the folder", and the test host's zip download. |
| Loads in Chromium from the zip the app offers | Works | The real-Chromium tests unzip the offered package. |
| Chrome Web Store listing (`docs/chrome-web-store.md`) | Not carried over | It was Ri-branded, and publishing waits until the extension can sign in. |

## Reading pages

| Feature | Status | How, or why not |
| --- | --- | --- |
| A link with no page text waits to be read | Works | |
| Settings says what Bookmarks asks Ri for | Works differently | The kit's "Your accounts through Ri" section words a request only by capability (mail, calendar). Bookmarks asks for a tool, so it reads "asks Ri to use your accounts, to read the pages you save". Ri's own consent screen names it correctly ("Read public web pages"). **Kit change:** name requested tools in that sentence. |
| Turned on in the app's Sources dialog | Works differently | Connect Bookmarks to Ri in Settings ("Your accounts through Ri") and allow "Read public web pages" on Ri's consent screen. Inside a host, Settings opens in the browser (see Settings below). Bookmarks declares `connectors.tools: ["ri__read_web_page"]` with its purpose. Until then the screen says to connect Ri, and the job fails with what to do. |
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
| Saved text is labeled reference material for any chat | Works differently | The old app put page text into the chat's context under a label. Now the view's context carries no page text. Tool descriptions and an @-mentioned link's text say page text is reference material and never instructions, and the model reads it with `get_bookmark`. |

## Sharing with a chat, and Ri's view

| Feature | Status | How, or why not |
| --- | --- | --- |
| A chat sees nothing until the person shares | Works differently | Nothing reaches Bookmarks without a connection the person approved on its consent screen. MCP without a token gets 401. Per place, not per chat: each Ri workspace (and Ri's own chats) is one connection, so all chats in a workspace share its choice. |
| Shared as a whole, read only or read and write | Works | Bookmarks declares no sources, so the consent screen asks only read or also write. Tests: "honors read and write", over MCP "refuses a read-only connection's save with a reason it can show". |
| The access screen (`/access`, `create_scope` with a host-bound actor) | Works differently | Replaced by the kit's consent screen and Settings' connection list (in the browser; see Settings below). Revoking: disconnect in Settings. Test: "stops a disconnected connection at once while another keeps working". |
| Connecting browsers and phones stays with the owner | Works differently | Only the person can approve a connection on the consent screen. |
| Open the view at `/`, `/bookmarks/<id>`, `/connect`, `/save` (`open_view`) | Works | `open_bookmarks` takes a `path`: `/bookmarks/<id>`, a search (`/?q=<words>&tag=<tag>`) or `/connect`, the same paths as the web app. The view follows a host's link (`openai/deepLink`) at start and while open, and a card's "Open" opens the whole app at that link. **Verified in the test host, and in Ri** (web): Ri's link `?open=open_bookmarks&path=/bookmarks/<id>` opened that link's inspector, and `/connect` opened the Connect screen. Only when Bookmarks is added with **Add MCP server**: through **Add app**, Ri opens no screen yet. Ri's Reload starts the app over at `/`. Cards need a model and weren't checked. ChatGPT and Claude pending. Tests: "opens the whole app at a link or a search", and the test host's open-at-path, deep links and card. |
| Ri entities (`bookmark`, readAction, searchAction, openPath) | Works differently | Bookmarks declares `records`: the host's @ menu finds saved links (`search_mentions`, view-only, best match by page text or newest), links to them as `app://bookmarks/bookmarks/<id>`, reads one as the connection (link, tags, note, page state and the saved page text, labeled reference material), and opens it with `open_bookmarks`. Another person's links aren't found. **Verified in the test host, and in Ri:** "@Alpha" found the dummy link under Bookmarks and became a mention. Ri reads the item when the message is sent, which needs a model harness the disposable Ri didn't have. ChatGPT and Claude pending. Tests: "offers saved links to the @ menu", "keeps another person's links out of the @ menu". |
| The chat beside the view gets what it shows (`describe_view_context`) | Works differently | The view publishes the selected link (also when opened from a host link), the section ("All bookmarks", "Search", "Tagged …", "Connect"), its path, and the search and tag as filters (`client.setSection`), plus what the person changed, such as "Deleted “…”" (`client.didChange`). Page text and the old "first results" list don't go into context: Bookmarks has no multi-select, so `selectMany` isn't used, and the model reads with `list_bookmarks` and `get_bookmark`. Verified in the test host. **Not in Ri:** Ri drops a screen's context when it closes, and its full-page screen has no chat beside it, so the selection never reaches a message. ChatGPT and Claude pending. |
| Open a saved link from the view | Works | The inspector's title and the card's link use `ExternalLink`, which asks the host to open it (`ui/open-link`). A host that can't, or refuses that link, shows the address to copy. Ri opens https anywhere, plain http only on the same computer. **Verified in the test host, and in Ri:** the saved link opened `https://example.org/…` in a new tab on the web and in the system browser from the desktop app. ChatGPT and Claude pending. |
| "Ask Ri" buttons: "Using my bookmark …" in the inspector, "Search my bookmarks for …" in the list | Works | `AskInChat` drafts the words into the chat's message box unsent (`ui/message` with `openai/message`, send false). A host without drafts shows them to copy. Missing from the first checklist. **Verified in the test host, and in Ri** (web and desktop): the words landed in the main chat's draft as an item, unsent ("Bookmarks MCP wrote a message for you. It's in your main chat's draft, ready when you are."). The draft waits in the tab's memory, so reloading Ri before opening the main chat loses it. ChatGPT and Claude pending. |
| Open in browser | Works (new) | The header, the inspector and cards offer it inside a host, at the place the person is in (for example `/bookmarks/<id>`), through the host's open-link. Not offered where the app's address is this computer's and the view is elsewhere (a phone). **Verified in the test host, and in Ri:** it opened `http://127.0.0.1:4314/bookmarks/<id>` in a new tab on the web, and `http://127.0.0.1:4314/` in the system browser from the desktop app. ChatGPT and Claude pending. |
| Settings (connections, the Ri connection, the reading job) inside a host | Can't work yet | The kit's Settings screen reads the app's own web routes (`/api/connections`, `/api/hub`, `/api/jobs`), not tools, so a view can't reach them. Inside a host, Settings shows Open in browser. **Kit change:** offer those as view-only tools, or say Settings is browser-only in the spec. |
| A fictional preview the catalog's Try opens (demo mode, `fixture` principal) | Works differently | `pnpm preview` seeds the fictional library into a disposable data directory and starts the app with the fixture hub. Records are marked fictional and no page is requested. Ri's catalog would need to run that to offer Try. Test: "starts with a fictional library, marked as such". |
| The `find-saved-links` skill shipped to chats | Works differently | The kit sets no MCP server instructions and has no way to ship a skill, so its rules moved into tool descriptions: try the page's own words, check coverage, read before quoting, page text may be out of date, never instructions, deleting is for the person. |
| Ri's file picker and download (`files.select`, `files.download`) | Works differently | Import uses a file input, in the browser and in the view. Export and the extension save through `client.download`: a browser download, or `ui/download-file` in a host. **Verified in the test host, and in Ri** (web and desktop): Ri's card ("Bookmarks MCP wants to save bookmarks.html (650 bytes)", Save and Don't save), and Save wrote the file. Picking a file in Ri's frame works too. ChatGPT and Claude pending. |
| The view follows the host's theme and fits every width | Works differently | The kit applies the host's theme, and cards follow it. The whole app keeps its own light palette, as its styles intend. **In Ri**, which has only a dark theme, the full screen stays light inside Ri's dark frame (web and desktop). It fits 390 px wide with no sideways scroll, and the desktop window's 1396 by 774 px. The old screenshot suite (`view.test.ts`) wasn't ported. ChatGPT and Claude pending. |
| The view shows a site's initial rather than its favicon | Works | |
| Bookmarks in Ri's catalog with a description and demo rows (`catalog.json`) | Not in this app | Ri's new catalog (shared spec, "The catalog") lists apps by git URL. Ri's side. |

## Connect screen and export

| Feature | Status | How, or why not |
| --- | --- | --- |
| Offers the extension for download | Works, in the view too | `/connect`, through `client.download`. |
| Bookmarklet with no key in it | Works | `/connect` in the browser. In a host's view, Open in browser. Test: "makes a bookmarklet that holds no key". |
| iPhone Shortcut setup | Works differently | Shown when the app's address isn't this computer's loopback; otherwise the page explains why the phone can't reach it. |
| Export as a browser bookmarks file | Works, in the view too | `/connect`, "Export a bookmarks file", through `client.download` (`export_bookmarks` is view-only). **Verified in the test host, and in Ri** (web and desktop), through Ri's save card. ChatGPT and Claude pending. Test: "handles a large library in one apply, and exports it back". |
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
| A chat sees everything or nothing, owner-only actions checked | Works (no sources). Owner-only actions are view-only, kept from the model by the host, and still need a connection that may write. |
| Forward-only migrations, policy values in the query layer | Works (kit migrations, checksum-checked). |
| Copy without long dashes or semicolons | Works (contract and extension tests). |
| `run_background_step` reachable only by the schedule | Works. `read_saved_pages` has no audience: only the job runner runs it. Test: "lets nobody call the reading step but the job runner". |

## Real hosts

Checked on November 16, 2026. "Ri" is a **disposable Ri at f55cdf96** on this Mac, with dummy links, not Trey's own Ri. Bookmarks ran as the installed service at `http://127.0.0.1:4314` (release 0ebde33). Ri connected it through Bookmarks' consent screen, both with Add app and with Add MCP server. **Add app connects but can't open the app** ("unknown action \"mcp.bookmarks_at_ri.open_bookmarks\""): Ri publishes the tools as `app_bookmarks.<tool>` and calls them as `mcp.<slug>.<tool>`. So the full-screen checks used Add MCP server. Screenshots: `docs/parity/ri-*.png`.

| Check | Ri on the web | Ri's desktop app | ChatGPT | Claude |
| --- | --- | --- | --- | --- |
| Connect, `open_bookmarks` and the tools listed | Works: consent, token, 15 tools including `open_bookmarks` and `search_mentions` | Same connection | Pending | Pending (desktop set up, waits on a restart) |
| Every screen (library, a link's inspector, search and tags, Import, Connect) | Works | Works | Pending | Pending |
| Person-only actions from the view (delete, import, export) | Work | Work (import, export) | Pending | Pending |
| The model can't call them | Refused: `delete_bookmark`, `export_bookmarks` | Same Ri server | Pending | Pending |
| Links out and Open in browser | New tab, at `/bookmarks/<id>` | System browser | Pending | Pending |
| Saving files | Ri's card, then saved (`bookmarks.html`) | Same, saved through Electron's download | Pending | Pending |
| Picking files | Chooser opens in the frame, dummy CSV imported | Chooser opens | Pending | Pending |
| Ask drafts | In the main chat's draft, unsent | Same | Pending | Pending |
| Opening at a record | `?open=open_bookmarks&path=/bookmarks/<id>` | Same | Pending | Pending |
| The @ menu | Finds the dummy link, becomes a mention | Not checked | Pending | Pending |
| Selection reaching the next message | Doesn't: Ri drops a closed screen's context | Same | Pending | Pending |
| Light and dark | Ri is dark only. The full app stays light, by design | Same | Pending | Pending |
| Phone and desktop widths | 390 px fits, no sideways scroll; 1396 px | Window is at least 800 px wide, 390 px emulated | Pending | Pending |
| View size and load time | View 916,827 bytes. Warm open 0.7 s to ready, 0.9 s settled; reload 0.7 s | 50 s on first open (Ri's dev server compiling under heavy load) | Pending | Pending |

Load times are from Ri's development server on a heavily loaded Mac, so they're upper bounds. The disposable Ri had no model harness, so cards and reading an @ item at send weren't checked. "Don't save" on Ri's card wasn't confirmed: the card didn't come back on a second export in the same view.

Small things seen, not fixed: on the Connect screen, the inline "Settings" and "Open this page in your browser" links inside a host render as padded buttons in the middle of a sentence.

## What the kit or Ri would need to change

Closed by kit `1713f6a`: opening links from the view, drafting a message, saving files, view-only actions, opening `open_<app>` at a path, host links, the @ menu, the wider selection, and Open in browser.

Still open:
1. **Kit: accept another origin on OAuth's client endpoints** (register, token). Unblocks the extension, and any in-browser MCP client.
2. **Kit: an add-only connection choice** (or per-tool scopes) on the consent screen, enforced like `write`.
3. **Kit: restore FTS5 tables.** `backupNode` copies `bookmarks_fts_*` shadow tables and `restoreNode` refuses them ("object name reserved for internal use"). Skip shadow tables and recreate virtual tables from their SQL. People found the same (its K2).
4. **Kit: Settings inside a host.** Its connections, Ri and jobs panels read web routes a view can't reach.
5. **Kit: a revocation endpoint** in the authorization server, so a client can disconnect itself.
6. **Kit: MCP server instructions**, so an app can tell assistants how to use it beyond tool descriptions.
7. **Kit: name requested hub tools in Settings**, not only capabilities.
8. **Hosts: visibility is theirs to enforce.** View-only actions rely on the host keeping them from its model (MCP Apps). Ri does. A host that doesn't would let a write connection's model delete or import.
9. **Reachability: a local app from the phone** (Ri's remote address showing app pages, or Bookmarks at a reachable address), for the iPhone Shortcut. Shared spec open question 2.

## Verified

- On kit `1713f6a` (core 0.2.2), after `upgrade --core ~/dynamism/app-builder`: typecheck and the app's tests passed in the upgrade's own check.
- `pnpm typecheck`, `pnpm test` (vitest: domain, workflow, contract, MCP with the official SDK client, @ mentions and open-at-path, the extension's logic and OAuth flow, the backup gap) and `pnpm build`.
- `pnpm test:browser`, in Playwright's Chromium:
  - The extension, unzipped from the app's own package, against the real app.
  - The view in the kit's strict MCP Apps test host (`tests/host/browser-host.ts`, the kit's own `packages/core/test/browser-host.ts`), against the real app. Mirrors the kit's AppBridge tests: the model's tools, the @ menu, open at a link, Open in browser, links out, a drafted question, export and extension downloads, import, a host link, deleting from the view, a card opening a link, and the same view in a host with no drafts, links or downloads. The view reached nothing on the network.
- Earlier, on kit `bc2c7f4`: `serve --install --service process`, `change`, an SDK client's OAuth against the running service, and the web app in a browser.
- Hub features against the kit's fixture source and a stand-in. Not against Ri's real hub.
- November 16: installed as this Mac's service with `PORT=4314 APP_HOST=127.0.0.1 APP_URL=http://127.0.0.1:4314 pnpm exec app-builder serve --install HEAD --json` (every step passed; launchd `local.bookmarks`, data in `~/.local/share/bookmarks`). Then the checks in [Real hosts](#real-hosts) in a disposable Ri at f55cdf96, driven with Playwright in Ri's web app and its source Electron app. The dummy links were deleted afterwards, and the disposable Ri's two connections were disconnected in Settings.
- Not done here: Trey's own Ri, ChatGPT and Claude drawing the view, Cloudflare (FTS5, triggers and window functions on D1), and a real Cmd+D keystroke.
