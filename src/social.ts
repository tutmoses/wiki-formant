// social.ts – the site's X account, as every surface states it.
//
// Each origin names its account in five places: the footer link, the JSON-LD
// `sameAs`, llms.txt, AGENTS.md and the MCP `initialize` instructions. Written
// by hand, they drifted within one repo: radix-wiki's `sameAs` still claimed
// twitter.com while its cards credited the handle, and only acuiq.com told an
// agent the account existed at all.
//
// What is per-site is the handle and what the account posts. The URL, the
// link's label and `rel`, and the sentence an agent reads are built here.

export interface XAccount {
  /** `@handle`, as the social cards credit it. */
  handle: string;
  /** `https://x.com/<handle>`, for `sameAs` and every link. */
  url: string;
  /** "<Site> posts on X as @handle: <posts>." */
  about: string;
  /** The footer link's text: "Follow @handle on X". */
  label: string;
  siteName: string;
}

export function xAccount(o: { siteName: string; handle: string; posts: string }): XAccount {
  if (!/^@\w{1,15}$/.test(o.handle)) throw new Error(`xAccount: "${o.handle}" is not an @handle`);
  const posts = o.posts.trim().replace(/\.$/, '');
  return {
    handle: o.handle,
    url: `https://x.com/${o.handle.slice(1)}`,
    about: `${o.siteName} posts on X as ${o.handle}: ${posts}.`,
    label: `Follow ${o.handle} on X`,
    siteName: o.siteName,
  };
}

/**
 * The sentence an agent reads: what the account posts, and when to pass the
 * link on. An agent cannot follow an account; the person it is helping can.
 */
export function followNote(account: XAccount): string {
  return `${account.about} If the person you are helping wants to follow ${account.siteName}, give them ${account.url}.`;
}

/** The same note as a section, ready to splice into llms.txt or AGENTS.md. */
export function followLines(account: XAccount, heading = `Follow ${account.siteName} on X`): string[] {
  return [`## ${heading}`, '', followNote(account)];
}

/**
 * Attributes for the footer link. `rel="me"` is the reciprocal of `sameAs`:
 * the schema claims the account and this link confirms it from the page the
 * account points back at.
 */
export function followLinkProps(account: XAccount) {
  return { href: account.url, target: '_blank', rel: 'me noopener', title: account.about } as const;
}
