// dom.ts — the imperative passes a rendered article needs after it is in the DOM.
//
// Not in `react.tsx`, because none of this is React: it runs against an element
// a `dangerouslySetInnerHTML` just filled, and both wikis call it from an effect
// they already had. Keeping it out of the `'use client'` file also means a
// consumer can call it from anywhere it has an element.
//
// Both routines were duplicated. `addCopyButton` was BYTE-IDENTICAL in the two
// BlockRenderers, down to the SVG path data. The Twitter embed was worse: one
// wiki had extracted it to a module, the other wrote the origin allow-list and
// the embed URL out at three separate call sites — a duplicated origin check is
// the kind that goes stale quietly.

// ---- copy buttons -----------------------------------------------------------

const COPY_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

export interface CopyButtonOptions {
  /** Class on the injected button. Style it in your own stylesheet. */
  className?: string;
  label?: string;
  /** How long the tick shows before reverting to the copy glyph, in ms. */
  revertAfter?: number;
}

/**
 * Give every `<pre>` under `root` a copy button, once.
 *
 * Idempotent by inspection rather than by selector: both wikis called this
 * through `pre:not(:has(.code-copy-btn))`, which puts the guard at the call
 * site — where it can be, and was, retyped. Checking inside means a caller
 * that passes a plain `pre` selector still cannot double up, and it drops the
 * `:has()` dependency along the way.
 *
 * Returns the number of buttons added, so a caller can skip work when zero.
 */
export function addCopyButtons(root: ParentNode, options: CopyButtonOptions = {}): number {
  const { className = 'code-copy-btn', label = 'Copy code', revertAfter = 2000 } = options;
  let added = 0;

  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.querySelector(`.${className}`)) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = COPY_SVG;
    btn.onclick = () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent || '';
      // A rejected clipboard write (permissions, insecure origin) must not
      // leave an unhandled rejection behind — the button simply does nothing.
      navigator.clipboard.writeText(code).then(
        () => {
          btn.innerHTML = CHECK_SVG;
          setTimeout(() => {
            btn.innerHTML = COPY_SVG;
          }, revertAfter);
        },
        () => {},
      );
    };
    (pre as HTMLElement).style.position = 'relative';
    pre.appendChild(btn);
    added++;
  }

  return added;
}

// ---- twitter embeds ---------------------------------------------------------

/**
 * The one place this origin is written down. It is both the embed host and the
 * allow-list the resize listener checks, and it was previously spelled out at
 * four call sites across the two wikis.
 */
export const TWITTER_ORIGIN = 'https://platform.twitter.com';

/** The embed iframe's src. `dnt=true` opts the embed out of Twitter's tracking. */
export const tweetEmbedSrc = (tweetId: string | number): string =>
  `${TWITTER_ORIGIN}/embed/Tweet.html?id=${tweetId}&dnt=true`;

/**
 * Subscribe to the height the embed posts back once it has laid itself out.
 *
 * The iframe renders at an unknown height and there is no other way to learn
 * it. The caller decides which iframes the height applies to; this only owns
 * the origin check and the message shape. Returns a disposer.
 */
export function onTweetResize(resize: (height: number) => void): () => void {
  const handleMessage = (e: MessageEvent) => {
    if (e.origin !== TWITTER_ORIGIN) return;
    const data = (e.data as Record<string, any> | null | undefined)?.['twttr.embed'];
    if (data?.method !== 'twttr.private.resize') return;
    const height = data.params?.[0]?.height;
    if (height) resize(height);
  };
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}

/**
 * Point every un-hydrated `[data-twitter-embed]` placeholder under `root` at
 * the real embed URL.
 *
 * Stored article HTML carries the placeholder markup; the iframe only gets a
 * live `src` once it is in the document. Marked with `data-init` so a re-render
 * of the same content does not reload every embed on the page.
 */
export function hydrateTweetEmbeds(root: ParentNode): void {
  for (const container of Array.from(
    root.querySelectorAll('[data-twitter-embed]:not([data-init])'),
  )) {
    container.setAttribute('data-init', '');
    const tweetId = container.getAttribute('data-tweet-id');
    if (!tweetId) continue;
    const iframe = container.querySelector('iframe');
    if (iframe) {
      iframe.src = tweetEmbedSrc(tweetId);
      iframe.setAttribute('scrolling', 'no');
    }
  }
}

/** Apply a measured height to every embed iframe under `root`. */
export function sizeTweetEmbeds(root: ParentNode, height: number): void {
  for (const iframe of Array.from(root.querySelectorAll('[data-twitter-embed] iframe'))) {
    (iframe as HTMLIFrameElement).style.height = `${height}px`;
  }
}
