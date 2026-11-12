// An MCP client (the official SDK) connecting to a running Bookmarks with OAuth, then using its tools.
// In local-owner mode the consent screen needs no sign-in, so this approves it the way a browser would.
// It saves one fictional link. Usage: pnpm exec tsx scripts/check-mcp-oauth.ts [http://127.0.0.1:4316]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { approveInBrowser } from "../tests/oauth";

const server = new URL("/mcp", process.argv[2] ?? "http://127.0.0.1:4316");
const redirect = "http://127.0.0.1:8877/callback";
const state: Record<string, unknown> = {};
let authorizeUrl: URL | null = null;
const provider: OAuthClientProvider = {
  get redirectUrl() { return redirect; },
  get clientMetadata() { return { client_name: "Probe host", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
  clientInformation: () => state.client as never,
  saveClientInformation: (info) => { state.client = info; },
  tokens: () => state.tokens as never,
  saveTokens: (tokens) => { state.tokens = tokens; },
  redirectToAuthorization: (url) => { authorizeUrl = url; },
  saveCodeVerifier: (verifier) => { state.verifier = verifier; },
  codeVerifier: () => String(state.verifier),
};
// 1. Without a token: 401 with the resource metadata.
const bare = await fetch(server, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
console.log("no token:", bare.status, bare.headers.get("www-authenticate"));
// 2. The SDK's own flow: discovery, registration, PKCE.
console.log("auth():", await auth(provider, { serverUrl: server }));
// 3. The person allows it on the app's consent screen (local-owner mode: no sign-in).
const approved = await approveInBrowser(authorizeUrl!.href, (request) => fetch(request));
console.log("consent screen named:", approved.offered.client.name, "returns to", approved.offered.client.returnsTo);
const code = new URL(approved.redirectURI).searchParams.get("code")!;
console.log("finish:", await auth(provider, { serverUrl: server, authorizationCode: code }));
// 4. Use the tools with the token, through the SDK transport.
const client = new Client({ name: "probe-host", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(server, { authProvider: provider }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((tool) => tool.name).join(", "));
const saved = await client.callTool({ name: "save_bookmark", arguments: { url: "https://harborlog.example/tide-tables", title: "Tide tables for small harbors", tags: ["sailing"], pageText: "Tide tables list the height of the water at each hour." } });
console.log("save_bookmark:", JSON.stringify((saved.structuredContent as any).result.record).slice(0, 160));
const found = await client.callTool({ name: "list_bookmarks", arguments: { query: "height of the water" } });
console.log("list_bookmarks:", (found.structuredContent as any).result.items.map((item: any) => item.title));
const card = await client.callTool({ name: "show_bookmarks", arguments: { query: "tide" } });
console.log("show_bookmarks:", (card.content as any)[0].text, Object.keys((card.structuredContent as any).data));
console.log("resource:", (await client.readResource({ uri: "ui://bookmarks/main" })).contents[0].mimeType);
// 5. Refresh: the SDK exchanges the refresh token and the new token works.
const before = (state.tokens as any).access_token;
console.log("refresh:", await auth(provider, { serverUrl: server }), (state.tokens as any).access_token !== before ? "new access token" : "same token");
await client.close();
