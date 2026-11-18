# Bookmarks: parity with the app that was built into Ri

Ri's Bookmarks app (`apps/bookmarks` at Ri commit `3c442810`) is ported here onto App Builder (core 0.2.2, kit `main` at `73c5266`). This checklist covers every feature and behavior in the old README, AGENTS.md, plugin.json, contract and tests, including the browser extension.

- **Works**: the same behavior, on the new path.
- **Works differently**: the person or an assistant can still do it, in another way (says how).
- **Can't work yet**: not possible on the new path as built (says why, and what would need to change in the kit or Ri).
- **Verified in the test host**: checked in the kit's strict MCP Apps test host (a scripts-only sandbox that may not reach the network and behaves like Ri: it keeps view-only tools from its model, drafts `ui/message`, records links and downloads, and sends deep links). **In Ri**: then checked on November 16, 2026 in a disposable Ri at f55cdf96 on this Mac, on the web and in its desktop app, with dummy links only (not a Ri Home in everyday use, which runs on another computer). ChatGPT and Claude are still pending. Details in [Real hosts](#real-hosts), screenshots in `docs/parity/`.

First checked on November 12, 2026, against kit `bc2c7f4`, with Ri's hub as read on Ri branch `claude/single-path-ri-approval-id`. Moved onto kit `1713f6a` (core 0.2.2, the full app in every host, shared spec §5) on November 16, then onto kit `ff47742` (backups that restore full-text search, production mode) on November 17, onto kit `023f92f` (OAuth clients in a browser, add-only connections, Settings inside the view) later that day, onto kit `7b1ba65` (a client asking for add-only, and an add-only connection seeing only its tools), and then onto kit `73c5266` (token revocation, server instructions, and plain words in Settings for what the app asks Ri for). Ri itself wasn't run.

## In short

- **Works**: saving, merging repeats, search over page text, tags, editing with revision checks, deleting, imports and export, the bookmarklet, the browser extension (it signs in on its own and asks only to add), saving from any assistant, reading pages in the background through Ri, read-only, read-and-write or add-only access per connection, a card in the chat and the whole app in Ri.
- **Now the whole app inside a host** (verified in the test host, and in a disposable Ri at f55cdf96 on the web and desktop. ChatGPT and Claude pending): deleting, importing, exporting and the extension download work in the view, kept from the model as view-only actions. Links open through the host, "Ask about this link" drafts a message, files save through the host, `open_bookmarks` opens at a link or a search, the @ menu offers saved links, the assistant hears the section, search and tag, Settings works in the view (verified in the test host. Real hosts pending), and Open in browser covers the rest.
- **Works differently**: the extension and every assistant connect with OAuth instead of a Ri key, so each browser shows up in Settings like any assistant. Reading pages is turned on by connecting Bookmarks to Ri and allowing "Read public web pages". The demo is `pnpm preview`.
- **Can't work yet**:
  1. **The iPhone Shortcut from a Mac-local app.** The phone can't reach `127.0.0.1`. A reachability question, not a host one: it works when Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in).
- **Closed by kit `023f92f`**: the extension signs in from inside the browser (kit #17, was "Can't work yet" 1), a connection can be limited to adding links (kit #17, was 2), and Settings works inside a host (kit #16, was 4). Kit `7b1ba65` (#19) lets the extension ask for add-only itself, and shows that connection only its one tool.
- **Closed by kit `73c5266`**: the extension's Disconnect ends its connection in the app (#21), assistants get the old skill's guidance as server instructions (#22), and Settings names what Bookmarks asks Ri for (#25).

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
| File: browser HTML, Raindrop HTML or CSV, any CSV with a url column, pasted links | Works, in the view too | Same parsers. Upload in parts, preview, apply once. The import actions are view-only, so Import works in the view as in the browser. Pasted links: verified in the test host. Choosing a file in a host's frame depends on what the host's frame allows (shared spec, "What each host allows"). **In Ri** (web and desktop) the file chooser opened from the sandboxed frame, and a dummy CSV previewed and imported. ChatGPT and Claude pending. Tests: the "import" group, including 20,000 links in one apply, 250 to a transaction. How long that takes is measured by `pnpm test:perf`, not `pnpm test`. |
| Preview before anything changes, apply exactly once, refuse a wrong digest, an expired preview or an unfinished upload | Works | Tests: "previews without changing anything", "refuses a wrong digest". |
| File encodings: UTF-8, UTF-16, Windows-1252, favicons dropped | Works | `readSelectedFile` now takes the file's bytes from the page. Ri's file picker (`files.select`) is replaced by an ordinary file input. |
| Bookmarklet: a small window that saves the page | Works differently | Set up from Bookmarks in the browser: a link can't be dragged out of a host's frame into the browser's bookmarks bar (the host's frame), so the view's Connect page offers Open in browser. It opens Bookmarks' own `/save` page, using the browser's sign-in to Bookmarks (or local-owner mode on this computer) instead of Ri's. Saves once, then lets the person add tags and a note. Verified in a browser against the running service: one record, labeled bookmarklet, a reload saves nothing. It holds no key. |
| iPhone Shortcut: the share sheet saves the link | Can't work yet for an app on the Mac. Works differently where the phone can reach the app | A reachability question, not a host one. The Shortcut used to post to Ri's remote address with a key. A Mac-local app is only at `127.0.0.1`, and Ri's remote address shows apps' views, not their pages or tools (shared spec, open question 2). The Connect page says so. When Bookmarks runs at an address the phone can reach (Cloudflare, or a private network with sign-in), the Shortcut opens `/save?via=shortcut&url=…` in Safari, where the person is signed in. To work from a Mac-local app: Ri's remote address would need to reach the app's pages, or offer a save that calls the app's `save_bookmark` through Ri's own connection. |
| Extension, Cmd+D copies the bookmark | Works | See the extension section. |
| Extension, toolbar button or Alt+Shift+S saves the tab with the text you can see | Works | Real-Chromium test: "saves the tab with the text you can see", on an add-only connection. |
| Extension, Import copies everything in the browser, folders as tags | Works | Real-Chromium test: "imports every bookmark in batches", on an add-only connection. |

## The browser extension

The extension is now an ordinary OAuth MCP client of Bookmarks, a public client with PKCE: it registers itself (`token_endpoint_auth_method: "none"`), opens Bookmarks' consent screen with `chrome.identity.launchWebAuthFlow`, keeps its own refresh token and calls `save_bookmarks` on `/mcp`. It saves to Bookmarks' own server and nowhere else. Since kit `023f92f` (#17) the kit answers the extension's origin on the routes OAuth clients use for themselves (discovery, register, token, `/mcp`), with CORS and no cookies, and keeps every other route on the app's own origin.

| Feature | Status | How, or why not |
| --- | --- | --- |
| Connect this browser | Works (since kit `023f92f`) | Real-Chromium test "signs in from its options page": Connect on the options page, registration and the token exchange sent from the extension's service worker with `Origin: chrome-extension://<id>`, the app's consent screen starting on "Only add" (the extension asked for it), then Connect's check and a saved bookmark. One call is stood in for: headless Chromium can't open `launchWebAuthFlow`'s window (it fails at once with "Authorization page could not be loaded", even for a page that loads), so the test opens the same address in a tab and hands back where the consent screen sent it. The real window wasn't checked. In Node, with the extension's origin on every POST: a wrong verifier is refused, CORS answers `*` without credentials, and a registration with a secret is refused. On a kit before `023f92f` the extension says to update Bookmarks. |
| Refresh an expired token | Works (since kit `023f92f`) | Real-Chromium test "refreshes an expired token from inside the browser": the extension refreshes, keeps the rotated refresh token and saves. Also from Node with the extension's origin. |
| "The key can add links and nothing else" | Works differently | The consent screen offers "Only add: Save links from a browser" beside "Read and make changes" and "Read only", because `save_bookmarks` is marked `adds: true`. An add-only connection may call only `save_bookmarks`, which answers only counts (a link already saved answers like a new one). Every other tool, the card, `open_bookmarks`, the @ menu and record reads are refused. Its `tools/list` holds only `save_bookmarks`, described as every other connection sees it (since kit `7b1ba65`). Settings shows "Can only add". **The extension asks for it** (since kit `7b1ba65`): its OAuth scope includes `add_only`, so the consent screen starts on "Only add" and says "… asks only to add. You can allow more." The kit accepts that scope without listing it in `scopes_supported`, so other assistants don't start there. The difference from the old key, which was add-only by construction: **the person can still allow more**, and the extension works the same with more. `save_bookmark` stays unmarked: it answers with the merged record, so an add-only connection could read any saved link by saving it again. Tests: over MCP "lets an add-only connection save links and nothing else" (including its tool list), "signs in from inside the browser … allowed only to add" (the scope, the request the consent screen reads, and the tool list), the contract's "offers only the extension's save", and the real-Chromium sign-in, where "Only add" is already chosen. |
| Pasted connection code shown once | Works differently | No code or key. The person enters Bookmarks' address and allows the browser on the consent screen. |
| Everything connected, and a way to remove it | Works differently | Each browser is its own OAuth connection, listed in Settings with every assistant ("Bookmarks browser extension on macOS · Can only add"), with Disconnect, in the browser and inside a host. Tests: "lists each connected browser in Settings", and the strict test host disconnecting the extension from Settings in the view. |
| Disconnect from the extension | Works (since kit `73c5266`) | Disconnect revokes the extension's refresh token at the app's revocation endpoint (RFC 7009, kit #21), then forgets it. That ends the whole connection: the access token stops at once, the refresh token is refused, and Settings no longer lists it. A connection kept by extension 0.2.2 or earlier holds no endpoint, so it asks discovery again. If Bookmarks doesn't answer, the extension still forgets its tokens, and the options page says to remove the browser in Bookmarks' Settings. A refresh that finishes after Disconnect can't bring the connection back. Tests: "disconnects itself" and "revokes a connection kept by an earlier version" (Node, from the extension's origin, with CORS), the revoke unit test, and in real Chromium the sign-in test's Disconnect plus "forgets its connection when Bookmarks is out of reach". |
| Asks for no site access up front, only the app's own host at Connect | Works | Optional host permission for the one host. Test: "asks for no site access up front". Adds `identity` for the sign-in window. |
| Cmd+D mirroring, folders as tags, ignores folders, browser pages and everything while switched off | Works | Real-Chromium tests, on an add-only connection. |
| Keeps links while the app is away and sends them when it answers, losing nothing | Works | Real-Chromium test, and unit tests of the queue. |
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
| Settings says what Bookmarks asks Ri for | Works (since kit `73c5266`) | "Your accounts through Ri" reads "Bookmarks asks Ri to read public web pages through Ri, to read the pages you save, so you can search what they said." The kit words it from `connectors.tools` (#25). Before, a request for a tool read "asks Ri to use your accounts". Ri's own consent screen names it too ("Read public web pages"). **Verified in the test host** (Settings in the view). |
| Turned on in the app's Sources dialog | Works differently | Connect Bookmarks to Ri in Settings ("Your accounts through Ri") and allow "Read public web pages" on Ri's consent screen. Settings works in the browser and inside a host (see Settings below). Bookmarks declares `connectors.tools: ["ri__read_web_page"]` with its purpose. Until then the screen says to connect Ri, and the job fails with what to do. |
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
| Shared as a whole, read only or read and write | Works | Bookmarks declares no sources, so the consent screen asks read only, read and make changes, or only add (`save_bookmarks`). Tests: "honors read and write", over MCP "refuses a read-only connection's save with a reason it can show" and "lets an add-only connection save links and nothing else". |
| The access screen (`/access`, `create_scope` with a host-bound actor) | Works differently | Replaced by the kit's consent screen and Settings' connection list (in the browser and inside a host; see Settings below). Revoking: disconnect in Settings. Test: "stops a disconnected connection at once while another keeps working". |
| Connecting browsers and phones stays with the owner | Works differently | Only the person can approve a connection on the consent screen. |
| Open the view at `/`, `/bookmarks/<id>`, `/connect`, `/save` (`open_view`) | Works | `open_bookmarks` takes a `path`: `/bookmarks/<id>`, a search (`/?q=<words>&tag=<tag>`) or `/connect`, the same paths as the web app. The view follows a host's link (`openai/deepLink`) at start and while open, and a card's "Open" opens the whole app at that link. **Verified in the test host, and in Ri** (web): Ri's link `?open=open_bookmarks&path=/bookmarks/<id>` opened that link's inspector, and `/connect` opened the Connect screen. Only when Bookmarks is added with **Add MCP server**: through **Add app**, Ri opens no screen yet. Ri's Reload starts the app over at `/`. Cards need a model and weren't checked. ChatGPT and Claude pending. Tests: "opens the whole app at a link or a search", and the test host's open-at-path, deep links and card. |
| Ri entities (`bookmark`, readAction, searchAction, openPath) | Works differently | Bookmarks declares `records`: the host's @ menu finds saved links (`search_mentions`, view-only, best match by page text or newest), links to them as `app://bookmarks/bookmarks/<id>`, reads one as the connection (link, tags, note, page state and the saved page text, labeled reference material), and opens it with `open_bookmarks`. Another person's links aren't found. **Verified in the test host, and in Ri:** "@Alpha" found the dummy link under Bookmarks and became a mention. Ri reads the item when the message is sent, which needs a model harness the disposable Ri didn't have. ChatGPT and Claude pending. Tests: "offers saved links to the @ menu", "keeps another person's links out of the @ menu". |
| The chat beside the view gets what it shows (`describe_view_context`) | Works differently | The view publishes the selected link (also when opened from a host link), the section ("All bookmarks", "Search", "Tagged …", "Connect"), its path, and the search and tag as filters (`client.setSection`), plus what the person changed, such as "Deleted “…”" (`client.didChange`). Page text and the old "first results" list don't go into context: Bookmarks has no multi-select, so `selectMany` isn't used, and the model reads with `list_bookmarks` and `get_bookmark`. Verified in the test host. **Not in Ri:** Ri drops a screen's context when it closes, and its full-page screen has no chat beside it, so the selection never reaches a message. ChatGPT and Claude pending. |
| Open a saved link from the view | Works | The inspector's title and the card's link use `ExternalLink`, which asks the host to open it (`ui/open-link`). A host that can't, or refuses that link, shows the address to copy. Ri opens https anywhere, plain http only on the same computer. **Verified in the test host, and in Ri:** the saved link opened `https://example.org/…` in a new tab on the web and in the system browser from the desktop app. ChatGPT and Claude pending. |
| "Ask Ri" buttons: "Using my bookmark …" in the inspector, "Search my bookmarks for …" in the list | Works | `AskInChat` drafts the words into the chat's message box unsent (`ui/message` with `openai/message`, send false). A host without drafts shows them to copy. Missing from the first checklist. **Verified in the test host, and in Ri** (web and desktop): the words landed in the main chat's draft as an item, unsent ("Bookmarks MCP wrote a message for you. It's in your main chat's draft, ready when you are."). The draft waits in the tab's memory, so reloading Ri before opening the main chat loses it. ChatGPT and Claude pending. |
| Open in browser | Works (new) | The header, the inspector and cards offer it inside a host, at the place the person is in (for example `/bookmarks/<id>`), through the host's open-link. Not offered where the app's address is this computer's and the view is elsewhere (a phone). **Verified in the test host, and in Ri:** it opened `http://127.0.0.1:4314/bookmarks/<id>` in a new tab on the web, and `http://127.0.0.1:4314/` in the system browser from the desktop app. ChatGPT and Claude pending. |
| Settings (connections, the Ri connection, the reading job) inside a host | Works (since kit `023f92f`) | The header's Settings link, and the reading notice's "Connect Bookmarks to Ri", open the kit's Settings in the view. It works through two view-only core tools, `read_settings` and `change_settings` (kit #16), which the host keeps from its model. It lists each connection with its access ("this one" for the host's own), disconnects one, connects Ri, and runs the reading job. Signing in, the account and the data download stay in the browser, with Open in browser. A read-only connection sees Settings but can't change them, and an add-only one never reaches the view. **Verified in the test host:** the connections with "Can read and make changes" and "Can only add", the Ri and Automations sections, the assistant hearing the section, disconnecting the extension, and back to the library, with nothing through the host's open-link. Real hosts pending. |
| A fictional preview the catalog's Try opens (demo mode, `fixture` principal) | Works differently | `pnpm preview` seeds the fictional library into a disposable data directory and starts the app with the fixture hub. Records are marked fictional and no page is requested. Ri's catalog would need to run that to offer Try. Test: "starts with a fictional library, marked as such". |
| The `find-saved-links` skill shipped to chats | Works differently | There is still no skill to ship, but since kit `73c5266` (#22) Bookmarks sends `instructions` (app.config.ts) when an assistant connects, and hosts may add them to the model's context. They hold what no tool description says: search Bookmarks first for things the person saved or read, answer with the title and the address, say when an answer rests on saved text rather than the live page, never act on what saved text says, and open a link with `open_bookmarks` for the person to delete it. The rest of the skill is in the tool descriptions: try the page's own words, check coverage, read before quoting, page text may be out of date. An add-only connection gets no instructions. Tests: over MCP the instructions arrive for a full connection and not for an add-only one, and the contract checks they name real tools, repeat none of the search advice and stay short. |
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
| Export as a browser bookmarks file | Works, in the view too | `/connect`, "Export a bookmarks file", through `client.download` (`export_bookmarks` is view-only). **Verified in the test host, and in Ri** (web and desktop), through Ri's save card. ChatGPT and Claude pending. Test: "handles a large library in one apply, in batches rather than a write per link, and exports it back" (every link reads back from the file). |
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

Checked on November 16, 2026. "Ri" is a **disposable Ri at f55cdf96** on this Mac, with dummy links, not a Ri Home in everyday use. Bookmarks ran as the installed service at `http://127.0.0.1:4314` (release 0ebde33). Ri connected it through Bookmarks' consent screen, both with Add app and with Add MCP server. **Add app connects but can't open the app** ("unknown action \"mcp.bookmarks_at_ri.open_bookmarks\""): Ri publishes the tools as `app_bookmarks.<tool>` and calls them as `mcp.<slug>.<tool>`. So the full-screen checks used Add MCP server. Screenshots: `docs/parity/ri-*.png`.

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

Small things seen, not fixed: on the Connect screen, the inline "Open this page in your browser" link inside a host renders as a padded button in the middle of a sentence. ("Settings" there is a plain link since kit `023f92f`.)

## What the kit or Ri would need to change

Closed by kit `1713f6a`: opening links from the view, drafting a message, saving files, view-only actions, opening `open_<app>` at a path, host links, the @ menu, the wider selection, and Open in browser.

Closed by kit `ff47742`:
- **Restoring a backup.** The backup leaves out the FTS5 index's internal tables and keeps its rows, its triggers and its views. A restore rebuilds the index. The backups test restores into an empty folder, then finds the saved links by their page text, and finds a link saved after the restore, so the triggers that keep search in step came back too.
- **Drafts keep their trailing space.** "Using my bookmark “…”, " and "Search my bookmarks for " now reach the chat's draft as written, so the person types straight on.
- **Production mode.** The service runs with `NODE_ENV=production`, and a failure reaches the view or an assistant without a stack or a file path.

Closed by kit `73c5266`:
- **A revocation endpoint** (#21). The extension's Disconnect revokes its refresh token, which ends the connection in the app.
- **MCP server instructions** (#22). The old skill's guidance that the tool descriptions don't carry.
- **Requested hub tools named in Settings** (#25). "asks Ri to read public web pages through Ri".

Closed by kit `7b1ba65` (#19):
- **A client asks for add-only.** The extension's `add_only` scope starts the consent screen on "Only add". It no longer tells the person what to choose.
- **An add-only connection sees only its tools.** Its `tools/list` holds only `save_bookmarks`. A call to another tool still gets the refusal that says why.

Closed by kit `023f92f`:
- **OAuth clients in a browser** (#17). Discovery, register, token and `/mcp` answer any origin with CORS and no cookies, for public clients with PKCE only. The extension signs in and refreshes from inside Chromium.
- **Add-only connections** (#17). `save_bookmarks` is the app's add action, and the consent screen offers "Only add".
- **Settings inside a host** (#16), through the core's view-only `read_settings` and `change_settings`.

Still open:
1. **Hosts: visibility is theirs to enforce.** View-only actions rely on the host keeping them from its model (MCP Apps). Ri does. A host that doesn't would let a write connection's model delete or import. The kit's Settings tools check the caller themselves.
2. **Reachability: a local app from the phone** (Ri's remote address showing app pages, or Bookmarks at a reachable address), for the iPhone Shortcut. Shared spec open question 2.

## Verified

- On kit `73c5266` (core 0.2.2, kit #20 to #25), November 17: `upgrade --core` (the packed core) `--health-timeout 300` stopped at its test gate (`checks_failed`), as kit #21 said it would. The discover test pinned `revocationEndpoint: null`. Nothing switched. On the upgrade's branch, the test now expects the endpoint. The extension's Disconnect revokes its connection (extension 0.2.3), Bookmarks sends instructions, and the host-view test reads Settings' new wording. Then, at a load average of about 5 on 16 CPUs: typecheck, `pnpm test` (113 passed) and `pnpm test:browser` (10 passed). The host-view test failed once, waiting for a card to go full screen, a check this round didn't touch. It then passed five runs in a row. The branch was merged into main as `upgrade` would have, and `change --health-timeout 300` switched `local.bookmarks` from `a7acbea` to the commit tagged `v0.1.4`.
- On kit `7b1ba65` (core 0.2.2, kit #18 and #19), November 17: `upgrade --core` (the packed core) `--health-timeout 300`, run with the kit's own CLI. Every step passed: typecheck, tests, build, the rehearsal (answered in 1 s), and the switch of `local.bookmarks` from `d9efcf7` to `4cbe3e9`, which also brought its service definition up to date. The upgrade merged itself and installed the core in the app's folder. Then the extension asked for `add_only` (extension 0.2.2), and at a load average of about 9 on 16 CPUs: typecheck, `pnpm test` (109 passed) and `pnpm test:browser` (9 passed).
- On kit `023f92f` (core 0.2.2, kit #14 to #17), November 17: `upgrade --core` (the packed core) `--health-timeout 300` stopped at its test gate (`checks_failed`), as kit #17 said it would. "is refused today when it signs in from inside the browser" now signed in, and the contract test met the core's new `read_settings` and `change_settings`. Its commit, `1d6dfb9`, was merged by hand and the app moved onto it. Then, at a load average of about 5 on 16 CPUs: typecheck, `pnpm test` (109 passed) and `pnpm test:browser` (9 passed) all passed. The browser tests now cover the extension's real sign-in, add-only and refresh in Chromium, and Settings inside the strict test host.
- On kit `a8e9b5d` (core 0.2.2, kit #13: no launchd throttling, a measured health wait, never restoring twice), November 17: `v0.1.1`. The upgrade switched `local.bookmarks` cleanly to `d63f655`, and its launchd plist now sets `NODE_ENV` to `production` and `ProcessType` to `Interactive`.
- On kit `ff47742` (core 0.2.2), after `upgrade --core ~/dynamism/app-builder` and `change`: typecheck, tests, build, the rehearsal on a copy of the live data and the switch of `local.bookmarks` all passed.
- On kit `1713f6a` (core 0.2.2), after `upgrade --core ~/dynamism/app-builder`: typecheck and the app's tests passed in the upgrade's own check.
- `pnpm typecheck`, `pnpm test` (vitest: domain, workflow, contract, MCP with the official SDK client, @ mentions and open-at-path, the extension's logic and OAuth flow, backup and restore) and `pnpm build`.
- `pnpm test` holds no wall-clock limits, since the kit's safe-change checks (`change`, `upgrade`, `serve --install`) run it on machines that may be busy. A 20,000-link import is checked by what it asks of the database instead: 80 transactions of 250 inserts, and lookups 90 links at a time, never one write per link. November 17, at a load average of about 105 on 16 CPUs: `pnpm test` passed in 11 s, and `pnpm test:browser` (the extension, and the view in the strict test host) in 11 s.
- `pnpm test:perf` measures the import (under 30 s) and a search and list (under 1 s). It prints the load average, and on a busy machine (more than one waiting task per CPU) says the times are not measured and skips them. Run it before each tag. November 17: not measured at load 121 on 16 CPUs. Forced to measure at about the same load, the import took 3.0 s and the search and list 10 ms. November 17 at `d63f655`, with the machine quiet (load 12.3 on 16 CPUs): measured, the 20,000-link import took 2.0 s and the search and list 8 ms.
- `pnpm test:browser`, in Playwright's Chromium:
  - The extension, unzipped from the app's own package, against the real app, with its pages rendered from the build: Connect, the consent screen already on "Only add" (with `launchWebAuthFlow`'s window stood in for by a tab), the token, a refresh from inside the browser, and saving on an add-only connection.
  - The view in the kit's strict MCP Apps test host (`tests/host/browser-host.ts`, the kit's own `packages/core/test/browser-host.ts`), against the real app. Mirrors the kit's AppBridge tests: the model's tools, the @ menu, open at a link, Open in browser, links out, a drafted question, export and extension downloads, import, a host link, deleting from the view, a card opening a link, Settings in the view (connections with their access, Ri, Automations, disconnecting the extension), and the same view in a host with no drafts, links or downloads. The view reached nothing on the network.
- Earlier, on kit `bc2c7f4`: `serve --install --service process`, `change`, an SDK client's OAuth against the running service, and the web app in a browser.
- Hub features against the kit's fixture source and a stand-in. Not against Ri's real hub.
- November 16: installed as this Mac's service with `PORT=4314 APP_HOST=127.0.0.1 APP_URL=http://127.0.0.1:4314 pnpm exec app-builder serve --install HEAD --json` (every step passed; launchd `local.bookmarks`, data in `~/.local/share/bookmarks`). Then the checks in [Real hosts](#real-hosts) in a disposable Ri at f55cdf96, driven with Playwright in Ri's web app and its source Electron app. The dummy links were deleted afterwards, and the disposable Ri's two connections were disconnected in Settings.
- Not done here: a Ri Home in everyday use, ChatGPT and Claude drawing the view, Cloudflare (FTS5, triggers and window functions on D1), and a real Cmd+D keystroke.
