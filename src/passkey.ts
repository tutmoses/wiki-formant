// passkey.ts – the door to a site's own admin pages: a passkey, and nothing else.
//
// No account, no password, no email. Whoever holds a passkey saved for the
// site is in. Every passkey, the first among them, is saved from an invite
// link, which the `passkey-invite` bin prints from a machine holding the
// database URL. A fresh deployment once saved the first passkey from whoever
// opened the page, so a stranger who got there before the owner held the door.
//
// A passkey is bound to the host it was saved on. One saved on localhost does
// not open the deployed site, and one saved on the site does not open localhost.
//
// Like analytics, the package owns the SQL and the app owns the connection. The
// two tables are Prisma models shipped in `prisma/passkey.prisma`, which the
// `prisma-models` bin copies into the app's schema folder.
//
// Every token is stored as its hash, so a read of the table opens nothing. A
// challenge is spent the moment a response quotes it, and only by the ceremony
// it was issued for; an invite the moment a passkey is saved with it. A session
// names the passkey that signed in, and lives only as long as that passkey's
// row: deleting a passkey signs out everyone who signed in with it.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { Sql } from './analytics.js';
import { clientKey, rateLimit, rateLimitedResponse } from './rate-limit.js';

export type { Sql };

/** A challenge's kind is its ceremony, so one issued to save a passkey cannot sign in. */
type Kind = 'session' | 'invite' | 'registration' | 'authentication';

const MINUTE = 60_000;
const DAY = 86_400_000;
const CHALLENGE_MS = 5 * MINUTE;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const token = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

/** Store a token's hash; the token is returned and kept nowhere else. */
async function issue(sql: Sql, kind: Kind, ms: number, value = token(), passkeyId: string | null = null) {
  await sql(`DELETE FROM "PasskeyToken" WHERE "expiresAt" < now()`);
  await sql(
    `INSERT INTO "PasskeyToken" (hash, kind, "expiresAt", "passkeyId") VALUES ($1, $2, now() + make_interval(secs => $3::int), $4)`,
    await hash(value),
    kind,
    Math.round(ms / 1000),
    passkeyId,
  );
  return value;
}

/** True once for a live token of this kind; it is gone either way. */
async function spend(sql: Sql, kind: Kind, value: string) {
  const rows = (await sql(
    `DELETE FROM "PasskeyToken" WHERE hash = $1 AND kind = $2 RETURNING "expiresAt" > now() AS live`,
    await hash(value),
    kind,
  )) as { live: boolean }[];
  return rows[0]?.live === true;
}

async function live(sql: Sql, kind: Kind, value: string) {
  const rows = (await sql(
    `SELECT 1 FROM "PasskeyToken" WHERE hash = $1 AND kind = $2 AND "expiresAt" > now()`,
    await hash(value),
    kind,
  )) as unknown[];
  return rows.length > 0;
}

export interface PasskeyGateOptions {
  sql: Sql;
  /** The name the browser shows when it offers to save the passkey. */
  rpName: string;
  /** Default `passkey_session`. */
  cookie?: string;
  /** How long a sign-in lasts. Default 90 days. */
  sessionDays?: number;
}

export interface PasskeyGate {
  /** The session cookie's name, for the app to read it with. */
  cookie: string;
  /** Whether a session cookie's value is a live session whose passkey is still saved. */
  signedIn(session: string | undefined): Promise<boolean>;
  /** A single-use invite token, good for `days`. The bin turns it into a link. */
  invite(days?: number): Promise<string>;
  /**
   * The whole sign-in route: `export const POST = gate.route`. The body is
   * `{ invite?, response? }`: without `response` it answers with the options
   * for the browser's prompt, with one it verifies it and sets the cookie. An
   * invite turns the prompt into saving one.
   */
  route(request: Request): Promise<Response>;
  /** The sign-out route: `export const DELETE = gate.signOut`. Ends the session and clears the cookie. */
  signOut(request: Request): Promise<Response>;
}

/** Any request that fails is told only that it failed. */
const refuse = (status: number, error: string) => Response.json({ error }, { status });

export function createPasskeyGate({ sql, rpName, cookie = 'passkey_session', sessionDays = 90 }: PasskeyGateOptions): PasskeyGate {
  const setCookie = (value: string, maxAge: number, secure: boolean) => {
    const attrs = [`${cookie}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (secure) attrs.push('Secure');
    return new Response(null, { status: 204, headers: { 'set-cookie': attrs.join('; ') } });
  };

  async function session(passkeyId: string, secure: boolean) {
    const value = await issue(sql, 'session', sessionDays * DAY, undefined, passkeyId);
    return setCookie(value, sessionDays * 86_400, secure);
  }

  return {
    cookie,
    signedIn: async value =>
      !!value &&
      ((await sql(
        `SELECT 1 FROM "PasskeyToken" t JOIN "Passkey" p ON p.id = t."passkeyId"
         WHERE t.hash = $1 AND t.kind = 'session' AND t."expiresAt" > now()`,
        await hash(value),
      )) as unknown[]).length > 0,
    invite: (days = 1) => issue(sql, 'invite', days * DAY),

    async signOut(request) {
      const value = request.headers
        .get('cookie')
        ?.split(/;\s*/)
        .find(c => c.startsWith(`${cookie}=`))
        ?.slice(cookie.length + 1);
      if (value) await spend(sql, 'session', value);
      return setCookie('', 0, new URL(request.url).protocol === 'https:');
    },

    async route(request) {
      const limited = rateLimit(clientKey('passkey', request.headers), { capacity: 10, refillPerSec: 0.2 });
      if (!limited.ok) return rateLimitedResponse(limited.retryAfterSec);

      // The browser writes the page's origin into what it signs, and binds the
      // passkey to the host, so the request's own origin is the one to expect.
      const { origin, hostname: rpID, protocol } = new URL(request.url);
      const body = (await request.json().catch(() => null)) as {
        invite?: unknown;
        response?: RegistrationResponseJSON & AuthenticationResponseJSON;
      } | null;
      const invite = typeof body?.invite === 'string' ? body.invite : undefined;
      const response = body?.response;
      const ceremony = invite ? 'registration' : 'authentication';
      const expectedChallenge = (challenge: string) => spend(sql, ceremony, challenge);

      if (!response) {
        if (invite && !(await live(sql, 'invite', invite))) return refuse(403, 'This invite has expired.');
        const options = invite
          ? await generateRegistrationOptions({
              rpName,
              rpID,
              userName: rpName,
              attestationType: 'none',
              // Discoverable, so signing in later asks for nothing: the device offers it.
              authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
            })
          : await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
        await issue(sql, ceremony, CHALLENGE_MS, options.challenge);
        return Response.json(options);
      }

      if (invite) {
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        }).catch(() => null);
        if (!result?.verified) return refuse(400, 'That passkey could not be saved.');
        // Spent after the check, so a failed prompt leaves the invite to try again.
        if (!(await spend(sql, 'invite', invite))) return refuse(403, 'This invite has expired.');
        const { credential } = result.registrationInfo;
        await sql(
          `INSERT INTO "Passkey" (id, "publicKey", counter, transports) VALUES ($1, $2, $3, $4::text[])`,
          credential.id,
          b64url(credential.publicKey),
          credential.counter,
          credential.transports ?? [],
        );
        return session(credential.id, protocol === 'https:');
      }

      const [passkey] = (await sql(
        `SELECT id, "publicKey", counter, transports FROM "Passkey" WHERE id = $1`,
        String(response.id),
      )) as { id: string; publicKey: string; counter: number; transports: string[] }[];
      if (!passkey) return refuse(403, 'This passkey is not one this site knows.');
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { ...passkey, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')) },
        requireUserVerification: false,
      }).catch(() => null);
      if (!result?.verified) return refuse(403, 'Sign-in failed.');
      await sql(`UPDATE "Passkey" SET counter = $2 WHERE id = $1`, passkey.id, result.authenticationInfo.newCounter);
      return session(passkey.id, protocol === 'https:');
    },
  };
}
