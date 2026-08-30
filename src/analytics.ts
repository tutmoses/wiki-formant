// analytics.ts — server-side Plausible events for agent surfaces.
//
// The proxy counts an "AI Bot Visit" by matching user agents, which cannot see
// inside a JSON-RPC envelope. So an MCP call is only countable by tool name at
// the route, and that extraction — from a body that is untrusted and may be a
// batch — is the part worth sharing. Every wiki in the workspace had its own
// copy of it, differing only in the default hostname.
//
// Deferral stays with the caller: `after()` in a route handler,
// `event.waitUntil` in a proxy. Both are framework calls, and importing one
// here would cost this package its zero-dependency guarantee.

import type { HeaderReader } from './rate-limit.js';

export interface PlausibleConfig {
  /** The hostname the Plausible property is registered under. */
  domain: string;
  /** Override for self-hosted Plausible. */
  endpoint?: string;
}

export interface PlausibleExtra {
  /** Revenue goal payload; accepted and ignored on plans without revenue goals. */
  revenue?: { currency: string; amount: number };
  /**
   * Send the visitor's own user agent so the event joins their session rather
   * than landing as the fixed bot-tracker pseudo-visitor. Right for an event
   * a person triggered; wrong for one a crawler did.
   */
  userAgent?: string;
}

const DEFAULT_ENDPOINT = 'https://plausible.io/api/event';

/**
 * The exact request shape Plausible's events API expects.
 *
 * Never rejects: analytics must not be able to fail a response the reader is
 * waiting on.
 */
export function plausibleEvent(
  config: PlausibleConfig,
  name: string,
  url: string,
  props: Record<string, string>,
  headers: HeaderReader,
  extra: PlausibleExtra = {},
): Promise<unknown> {
  return fetch(config.endpoint ?? DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': extra.userAgent || 'Mozilla/5.0 (compatible; BotTracker/1.0)',
      'X-Forwarded-For':
        headers.get('x-forwarded-for') || headers.get('x-real-ip') || '127.0.0.1',
    },
    body: JSON.stringify({
      name,
      url,
      domain: config.domain,
      props: JSON.stringify(props),
      ...(extra.revenue ? { revenue: extra.revenue } : {}),
    }),
  }).catch(() => undefined);
}

/**
 * Props for an "MCP Call" event, read out of the JSON-RPC envelope.
 *
 * The body is untrusted and may be a batch, a notification, or malformed
 * entirely, so every extraction is defensive and the result is always a
 * complete props object. A batch is attributed to its first member — the
 * alternative is one event per member, which would make a fan-out look like
 * traffic it is not.
 */
export function mcpCallProps(
  request: { headers: HeaderReader; url: string },
  body: unknown,
  server?: string,
): Record<string, string> {
  const first = (Array.isArray(body) ? body[0] : body) as
    | { method?: unknown; params?: { name?: unknown } }
    | undefined;
  const method = typeof first?.method === 'string' ? first.method : 'unknown';
  const tool = typeof first?.params?.name === 'string' ? first.params.name : undefined;
  const ua = (request.headers.get('user-agent') || 'unknown').slice(0, 80);
  return { ...(server ? { server } : {}), method, ...(tool ? { tool } : {}), ua };
}

/** The hostname of a site URL, for the `domain` a Plausible property is filed under. */
export function plausibleDomain(siteUrl: string | undefined, fallback: string): string {
  try {
    return new URL(siteUrl || fallback).hostname;
  } catch {
    return fallback.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}
