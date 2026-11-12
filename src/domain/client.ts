/**
 * Ways to save from outside the app that need no key. Each opens this app's
 * own save page, where the browser's sign-in to the app (or local-owner mode
 * on this computer) applies. Built here so the screens and tests share one form.
 */

/** The address of the save page for one link. */
export function savePageUrl(appUrl: string, link: { url: string; title?: string | null; note?: string | null }): string {
  const target = new URL("/save", appUrl);
  target.searchParams.set("url", link.url);
  if (link.title) target.searchParams.set("title", link.title);
  if (link.note) target.searchParams.set("note", link.note);
  return target.href;
}

/**
 * The bookmarklet. It holds no secret: it opens this app's save page in a
 * small window. A page can refuse a script but not a new window.
 */
export function bookmarkletFor(appUrl: string): string {
  const save = new URL("/save", appUrl).href;
  const code = `(function(){var u=location.href;if(u.length>1000){alert('This link is too long to save from here.');return}var s=String(getSelection()).slice(0,500);window.open(${JSON.stringify(save)}+'?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(document.title.slice(0,300))+'&note='+encodeURIComponent(s),'bookmarks-save','width=480,height=800')})()`;
  return `javascript:${code}`;
}

/** What an iPhone Shortcut opens from the share sheet: the save page, with the shared link appended. */
export const shortcutPrefix = (appUrl: string) => `${new URL("/save", appUrl).href}?via=shortcut&url=`;

/** A phone can reach this app only at an address that isn't this computer's loopback. */
export function reachableFromPhone(appUrl: string): boolean {
  const host = new URL(appUrl).hostname;
  return !(host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host));
}
