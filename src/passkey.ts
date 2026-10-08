// passkey.ts – the door to a site's own admin pages: a passkey, and nothing else.
//
// No account, no password, no email. Whoever holds a passkey saved for the
// site is in. While none is saved, the page saves the first one without asking
// for anything, so the owner opens it from the deployed site the way they would
// any other. Every passkey after that needs an invite link, which the
// `passkey-invite` bin prints from a machine holding the database URL.
//
// A passkey is bound to the host it was saved on. One saved on localhost does
// not open the deployed site, and one saved on the site does not open localhost.
//
// Like analytics, the package owns the SQL and the app owns the connection. The
// app declares the two tables in its own schema:
//
//   model Passkey {
//     id         String   @id // the credential id, base64url
//     publicKey  String       // base64url
//     counter    Int
//     transports String[]
//     createdAt  DateTime @default(now()) @db.Timestamptz(3)
//   }
//
//   model PasskeyToken {
//     hash      String   @id // sha-256 of the token, base64url
//     kind      String       // session | invite | challenge
//     expiresAt DateTime @db.Timestamptz(3)
//   }
//
// Every token is stored as its hash, so a read of the table opens nothing. A
// challenge is spent the moment a response quotes it, and an invite the moment
// a passkey is saved with it. The first passkey without an invite is checked
// against an empty table in the insert itself, so two people racing to it
// cannot both win.

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

type Kind = 'session' | 'invite' | 'challenge';

const MINUTE = 60_000;
const DAY = 86_400_000;
const CHALLENGE_MS = 5 * MINUTE;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const token = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

/** Store a token's hash; the token is returned and kept nowhere else. */
async function issue(sql: Sql, kind: Kind, ms: number, value = token()) {
  await sql(`DELETE FROM "PasskeyToken" WHERE "expiresAt" < now()`);
  await sql(
    `INSERT INTO "PasskeyToken" (hash, kind, "expiresAt") VALUES ($1, $2, now() + make_interval(secs => $3::int))`,
    await hash(value),
    kind,
    Math.round(ms / 1000),
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
  /** Whether a session cookie's value is a live session. */
  signedIn(session: string | undefined): Promise<boolean>;
  /** True while no passkey is saved, when the page offers to save the first one. */
  open(): Promise<boolean>;
  /** A single-use invite token, good for `days`. The bin turns it into a link. */
  invite(days?: number): Promise<string>;
  /**
   * The whole sign-in route: `export const POST = gate.route`. The body is
   * `{ invite?, response? }`: without `response` it answers with the options
   * for the browser's prompt, with one it verifies it and sets the cookie. An
   * invite, or a site with no passkey yet, turns the prompt into saving one.
   */
  route(request: Request): Promise<Response>;
}

/** Any request that fails is told only that it failed. */
const refuse = (status: number, error: string) => Response.json({ error }, { status });

export function createPasskeyGate({ sql, rpName, cookie = 'passkey_session', sessionDays = 90 }: PasskeyGateOptions): PasskeyGate {
  async function session(secure: boolean) {
    const value = await issue(sql, 'session', sessionDays * DAY);
    const attrs = [`${cookie}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${sessionDays * 86_400}`];
    if (secure) attrs.push('Secure');
    return new Response(null, { status: 204, headers: { 'set-cookie': attrs.join('; ') } });
  }

  const open = async () => ((await sql(`SELECT 1 FROM "Passkey" LIMIT 1`)) as unknown[]).length === 0;

  return {
    cookie,
    signedIn: async value => !!value && live(sql, 'session', value),
    open,
    invite: (days = 1) => issue(sql, 'invite', days * DAY),

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
      const expectedChallenge = (challenge: string) => spend(sql, 'challenge', challenge);

      if (!response) {
        if (invite && !(await live(sql, 'invite', invite))) return refuse(403, 'This invite has expired.');
        const options = invite || (await open())
          ? await generateRegistrationOptions({
              rpName,
              rpID,
              userName: rpName,
              attestationType: 'none',
              // Discoverable, so signing in later asks for nothing: the device offers it.
              authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
            })
          : await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
        await issue(sql, 'challenge', CHALLENGE_MS, options.challenge);
        return Response.json(options);
      }

      if (invite || (await open())) {
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        }).catch(() => null);
        if (!result?.verified) return refuse(400, 'That passkey could not be saved.');
        // Spent after the check, so a failed prompt leaves the invite to try again.
        if (invite && !(await spend(sql, 'invite', invite))) return refuse(403, 'This invite has expired.');
        const { credential } = result.registrationInfo;
        const saved = (await sql(
          `INSERT INTO "Passkey" (id, "publicKey", counter, transports)
           SELECT $1, $2, $3, $4::text[] WHERE $5::boolean OR NOT EXISTS (SELECT 1 FROM "Passkey") RETURNING id`,
          credential.id,
          b64url(credential.publicKey),
          credential.counter,
          credential.transports ?? [],
          !!invite,
        )) as unknown[];
        if (!saved.length) return refuse(403, 'This site already has a passkey. Adding another takes an invite.');
        return session(protocol === 'https:');
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
      return session(protocol === 'https:');
    },
  };
}
