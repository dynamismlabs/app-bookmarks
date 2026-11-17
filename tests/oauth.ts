/**
 * The person's browser approving an authorization address: it follows the
 * app's redirects (local-owner mode needs no sign-in), answers the consent
 * screen with `access`, and returns where the app sends the browser next.
 * Adapted from the kit's own tests (tests/connections.ts in App Builder).
 */
export async function approveInBrowser(authorizationURL: string, send: (request: Request) => Promise<Response>, access: { write?: boolean; addOnly?: boolean } = {}) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const remember = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
  };
  let url = new URL(authorizationURL);
  for (let hop = 0; hop < 6; hop++) {
    const response = await send(new Request(url, { redirect: "manual", headers: { cookie: cookie() } }));
    remember(response);
    const location = response.headers.get("location");
    if (!location) throw new Error(`Authorization stopped at ${url.pathname} with ${response.status}: ${await response.text()}`);
    url = new URL(location, url);
    if (url.pathname !== "/oauth/consent") continue;
    const origin = url.origin;
    const consent = await send(new Request(origin + "/api/connections/consent?consent_code=" + url.searchParams.get("consent_code"), { headers: { cookie: cookie(), origin } }));
    const offered = await consent.json() as { client: { name: string; returnsTo: string }; sources: unknown; adds?: { name: string; title: string }[]; requested?: { addOnly?: boolean } };
    if (!consent.ok) throw new Error(JSON.stringify(offered));
    const answer = await send(new Request(origin + "/api/auth/oauth2/consent", {
      method: "POST", headers: { "content-type": "application/json", origin, cookie: cookie() },
      body: JSON.stringify({ accept: true, consent_code: url.searchParams.get("consent_code"), access: { sources: null, write: true, ...access } }),
    }));
    const body = await answer.json() as { redirectURI?: string; message?: string };
    if (!answer.ok || !body.redirectURI) throw new Error(body.message ?? `Consent failed with ${answer.status}`);
    return { offered, redirectURI: body.redirectURI };
  }
  throw new Error("Authorization never reached the consent screen.");
}
