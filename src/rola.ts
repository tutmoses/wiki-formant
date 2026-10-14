// rola.ts — Radix On-Ledger Authentication: a single-use challenge, the wallet's
// proof of it, and the HS256 token a verified address is handed.
//
// radix-wiki and caper sign in the same way and keep a session differently:
// radix-wiki a `Session` row behind a seven-day cookie, caper a stateless token
// it slides forward on every visit, with a twelve-hour one for agents. What
// they share is everything up to the token, plus the token's own arithmetic,
// and that is all this holds. Where the two copies differed it takes the
// stricter: a challenge is consumed by one conditional delete, so two requests
// racing with one signature cannot both pass; expired challenges are purged as
// new ones are made; only an account proof signs in, which both apps already
// enforced; a secret under 32 characters refuses to start, since HS256 is only
// as strong as its secret; and verification pins HS256.
//
// The challenge table is a port, not an import: a Prisma client is generated
// per app, and both apps' `prisma.challenge` already satisfies it. `jose` and
// `@radixdlt/rola` are optional peers, needed only by an app importing this.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { Rola } from '@radixdlt/rola';

export interface SignedChallenge {
  challenge: string;
  address: string;
  proof: {
    publicKey: string;
    signature: string;
    curve: 'curve25519' | 'secp256k1';
  };
}

/** What `prisma.challenge` already is, narrowed to the two calls this makes. */
export interface ChallengeStore {
  create(args: { data: { challenge: string; expiresAt: Date } }): Promise<unknown>;
  deleteMany(args: {
    where: { challenge?: string; expiresAt: { lt: Date } | { gt: Date } };
  }): Promise<{ count: number }>;
}

export interface RolaOptions {
  expectedOrigin: string;
  dAppDefinitionAddress: string;
  networkId: number;
  applicationName: string;
  challenges: ChallengeStore;
  /** Default 300: the wallet round-trip, with room for a slow signer. */
  challengeTtlSec?: number;
}

export type Verification = { isValid: true } | { isValid: false; error: string };

export interface RolaAuth {
  generateChallenge(): Promise<{ challenge: string; expiresAt: Date }>;
  /** Consumes the challenge whatever the outcome, so a signature cannot be retried. */
  verifySignedChallenge(signed: SignedChallenge): Promise<Verification>;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function createRola({ challenges, challengeTtlSec = 300, ...identity }: RolaOptions): RolaAuth {
  const rola = Rola(identity);
  return {
    async generateChallenge() {
      const challenge = hex(crypto.getRandomValues(new Uint8Array(32)));
      const expiresAt = new Date(Date.now() + challengeTtlSec * 1000);
      await challenges.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await challenges.create({ data: { challenge, expiresAt } });
      return { challenge, expiresAt };
    },

    async verifySignedChallenge(signed) {
      try {
        const { count } = await challenges.deleteMany({
          where: { challenge: signed.challenge, expiresAt: { gt: new Date() } },
        });
        if (count !== 1) {
          console.error('ROLA: challenge invalid or expired', `${signed.challenge.slice(0, 16)}...`);
          return { isValid: false, error: 'Invalid or expired challenge' };
        }
        // A persona proof names no account, and the session belongs to the
        // address the proof verified, never to one a request body names.
        if (!signed.address.startsWith('account_')) {
          return { isValid: false, error: 'Sign in with an account proof' };
        }
        const result = await rola.verifySignedChallenge({ ...signed, type: 'account' });
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

/**
 * The signing key for an environment variable's value. Throws on a missing or
 * short one: a low-entropy HS256 secret is crackable offline from one captured
 * token, which would let anyone mint a session for any address. Generate one
 * with `openssl rand -base64 48`.
 */
export function sessionSecret(value: string | undefined): Uint8Array {
  if (!value || value.length < 32) {
    throw new Error('The session secret must be at least 32 characters of high-entropy randomness');
  }
  return new TextEncoder().encode(value);
}

/** An HS256 token carrying `claims`, issued now, expiring in `ttlSec`, with a unique `jti`. */
export function signSession(claims: JWTPayload, secret: Uint8Array, ttlSec: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .setJti(crypto.randomUUID())
    .sign(secret);
}

/**
 * The claims of a token that verifies, or null for a bad signature, an expired
 * `exp` or any other algorithm. HS256 is pinned, so a token cannot choose how
 * it is checked.
 */
export async function verifySession<T extends object = JWTPayload>(
  token: string,
  secret: Uint8Array,
): Promise<(T & JWTPayload) | null> {
  try {
    const { payload } = await jwtVerify<T>(token, secret, { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

/** An `Authorization: Bearer` token, the way an agent presents the cookie's. */
export function bearerToken(headers: { get(name: string): string | null }): string | null {
  return headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}
