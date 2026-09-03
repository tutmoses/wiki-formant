// rola.ts — Radix On-Ledger Authentication: challenge, proof, session.
//
// Both Radix wikis had written this file, and the two copies were 94% identical
// — the whole difference was a cookie name, plus the half radix-wiki had learned
// since and miow had not: persona (identity_*) proofs, which miow rejected
// because it passed `type: 'account'` unconditionally, and the error logging
// that makes a failed verification diagnosable at all.
//
// This is radix-wiki's version, parameterised on the two things a second wiki
// actually differs in: the cookie name and its dApp identity.
//
// Storage and cookies are ports rather than imports. A Prisma client is
// generated per repo and cannot be shared, and taking `next/headers` here would
// bind the package to a framework it otherwise knows nothing about. Both ports
// are shaped so the caller passes what it already has — the delegate and the
// cookie jar — with no adapter to write.
//
// `jose` and `@radixdlt/rola` are optional peers: only a repo importing this
// subpath needs them installed.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { Rola } from '@radixdlt/rola';

export interface AuthSession {
  userId: string;
  radixAddress: string;
  personaAddress?: string;
  displayName?: string;
  expiresAt: Date;
}

export interface SignedChallenge {
  challenge: string;
  address: string;
  proof: {
    publicKey: string;
    signature: string;
    curve: 'curve25519' | 'secp256k1';
  };
}

interface SessionPayload extends JWTPayload {
  userId: string;
  radixAddress: string;
  personaAddress?: string;
  displayName?: string;
}

/**
 * The two Prisma delegates this needs, structurally. Both wikis' `Session` and
 * `Challenge` models already satisfy it, so the binding is
 * `{ session: prisma.session, challenge: prisma.challenge }`.
 */
export interface RolaStore {
  session: {
    create(args: { data: { userId: string; token: string; expiresAt: Date } }): Promise<unknown>;
    findUnique(args: { where: { token: string } }): Promise<{ id: string; expiresAt: Date } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    deleteMany(args: { where: { token: string } }): Promise<unknown>;
  };
  challenge: {
    create(args: { data: { challenge: string; expiresAt: Date } }): Promise<unknown>;
    findUnique(args: { where: { challenge: string } }): Promise<{ id: string; expiresAt: Date } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

/** What `await cookies()` already gives you, narrowed to what this uses. */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    expires: Date;
    path: string;
  }): void;
  delete(name: string): void;
}

export interface RolaAuthConfig {
  /** This wiki's session cookie. The one thing the two copies actually differed in. */
  cookieName: string;
  jwtSecret: Uint8Array;
  store: RolaStore;
  cookies: () => Promise<CookieJar>;
  rola: {
    expectedOrigin: string;
    dAppDefinitionAddress: string;
    networkId: number;
    applicationName: string;
  };
  sessionDurationMs?: number;
  challengeTtlSec?: number;
  /** Defaults to `process.env.NODE_ENV === 'production'`. */
  secureCookies?: boolean;
}

const DEFAULT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHALLENGE_TTL_SEC = 300;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/**
 * A wallet address tells you which proof type it is, and getting it wrong is a
 * silent rejection: the ROLA library verifies an `identity_*` proof only under
 * `type: 'persona'`. One of the two copies this replaces hardcoded `'account'`
 * and so could never accept a persona login at all.
 */
export function proofType(address: string): 'account' | 'persona' | null {
  if (address.startsWith('account_')) return 'account';
  if (address.startsWith('identity_')) return 'persona';
  return null;
}

export interface RolaAuth {
  createSession(userId: string, radixAddress: string, personaAddress?: string, displayName?: string): Promise<string>;
  getSession(request?: { headers: { get(name: string): string | null } }): Promise<AuthSession | null>;
  destroySession(): Promise<void>;
  generateChallenge(): Promise<{ challenge: string; expiresAt: Date }>;
  verifySignedChallenge(signed: SignedChallenge): Promise<{ isValid: boolean; error?: string }>;
}

export function createRolaAuth(config: RolaAuthConfig): RolaAuth {
  const {
    cookieName,
    jwtSecret,
    store,
    cookies,
    sessionDurationMs = DEFAULT_SESSION_MS,
    challengeTtlSec = DEFAULT_CHALLENGE_TTL_SEC,
    secureCookies = process.env.NODE_ENV === 'production',
  } = config;

  const rola = Rola(config.rola);

  async function verifyToken(token: string): Promise<AuthSession | null> {
    try {
      const { payload } = await jwtVerify<SessionPayload>(token, jwtSecret);
      const session = await store.session.findUnique({ where: { token } });
      if (!session || session.expiresAt < new Date()) {
        if (session) await store.session.delete({ where: { id: session.id } }).catch(() => {});
        return null;
      }
      return {
        userId: payload.userId,
        radixAddress: payload.radixAddress,
        personaAddress: payload.personaAddress,
        displayName: payload.displayName,
        expiresAt: new Date(payload.exp! * 1000),
      };
    } catch {
      return null;
    }
  }

  /** Consumes the challenge: a replayed one must not verify twice. */
  async function validateChallenge(challenge: string): Promise<boolean> {
    const stored = await store.challenge.findUnique({ where: { challenge } });
    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await store.challenge.delete({ where: { id: stored.id } });
      return false;
    }
    await store.challenge.delete({ where: { id: stored.id } });
    return true;
  }

  return {
    async createSession(userId, radixAddress, personaAddress, displayName) {
      const expiresAt = new Date(Date.now() + sessionDurationMs);
      const token = await new SignJWT({ userId, radixAddress, personaAddress, displayName })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .setJti(crypto.randomUUID())
        .sign(jwtSecret);

      await store.session.create({ data: { userId, token, expiresAt } });

      const jar = await cookies();
      jar.set(cookieName, token, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        expires: expiresAt,
        path: '/',
      });

      return token;
    },

    async getSession(request) {
      const jar = await cookies();
      const cookieToken = jar.get(cookieName)?.value;
      if (cookieToken) {
        const session = await verifyToken(cookieToken);
        if (session) return session;
      }

      // Agents authenticate per-request with a Bearer token rather than a
      // cookie, so the header is a second, equal route in — not a fallback.
      if (request) {
        const authHeader = request.headers.get('Authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (bearerToken) return verifyToken(bearerToken);
      }

      return null;
    },

    async destroySession() {
      const jar = await cookies();
      const token = jar.get(cookieName)?.value;
      if (token) await store.session.deleteMany({ where: { token } });
      jar.delete(cookieName);
    },

    async generateChallenge() {
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      const challenge = bytesToHex(array);
      const expiresAt = new Date(Date.now() + challengeTtlSec * 1000);

      await store.challenge.create({ data: { challenge, expiresAt } });
      return { challenge, expiresAt };
    },

    async verifySignedChallenge(signedChallenge) {
      try {
        if (!(await validateChallenge(signedChallenge.challenge))) {
          console.error('ROLA: challenge validation failed', signedChallenge.challenge.slice(0, 16) + '...');
          return { isValid: false, error: 'Invalid or expired challenge' };
        }

        const type = proofType(signedChallenge.address);
        if (!type) {
          throw new Error(`ROLA: unrecognized address prefix (expected account_* or identity_*): ${signedChallenge.address}`);
        }

        const result = await rola.verifySignedChallenge({ ...signedChallenge, type });

        if (result.isErr()) {
          console.error('ROLA: verification failed', result.error.reason, result.error);
          return { isValid: false, error: result.error.reason };
        }

        return { isValid: true };
      } catch (error) {
        console.error('ROLA verification error:', error);
        return { isValid: false, error: 'Verification failed' };
      }
    },
  };
}
