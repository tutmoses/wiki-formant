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
import { McpToolError, type McpTool } from './mcp.js';

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
        // Anything but a string is a filter, not a challenge: an absent one
        // matches every row, so one bad request would spend every pending
        // sign-in's challenge.
        if (typeof signed?.challenge !== 'string' || typeof signed.address !== 'string') {
          return { isValid: false, error: 'Invalid or expired challenge' };
        }
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

export interface RolaLoginToolsOptions {
  /** What a token writes to, as in "Step 1 of writing to the wiki". */
  site: string;
  dAppDefinitionAddress: string;
  /** The origin the verifier checks, which the signed message names. */
  origin: string;
  generateChallenge: () => Promise<{ challenge: string; expiresAt: Date | string }>;
  /**
   * Verify the proof and issue a token. Throw an `McpToolError` to refuse; the
   * answer's other fields (the signed-in address) are passed through.
   */
  login: (signed: SignedChallenge) => Promise<{ token: string; expiresAt: Date | string } & Record<string, unknown>>;
  /** Default 300, as `createRola`'s. */
  challengeTtlSec?: number;
  tokenTtlSec: number;
  /** The calls the token is sent on, as in "create_page / edit_page". Default "tool". */
  writeTools?: string;
  notes?: {
    /** A sentence added to `get_challenge`'s description. */
    challenge?: string;
    /** Lines added to, or replacing lines of, the signing recipe the challenge carries. */
    sign?: Record<string, string>;
    /** `login`'s `address` argument description. */
    address?: string;
  };
}

/** "12h", or "7-day" for whole days past one. */
const span = (sec: number) => (sec % 86_400 === 0 && sec > 86_400 ? `${sec / 86_400}-day` : `${Math.round(sec / 3600)}h`);

/**
 * `get_challenge` and `login`, the two MCP tools that turn an agent's own key
 * into a Bearer token: the challenge carries the exact message to sign, and a
 * refused login says to start again, since a challenge is spent either way.
 */
export function rolaLoginTools(o: RolaLoginToolsOptions): Array<McpTool & Required<Pick<McpTool, 'title' | 'annotations'>>> {
  const minutes = (o.challengeTtlSec ?? 300) / 60;
  const carries = o.writeTools ?? 'tool';
  return [
    {
      name: 'get_challenge',
      title: 'Start a login',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        `Step 1 of writing to ${o.site}: a single-use ROLA challenge (${minutes}-minute expiry). ` +
        'The response spells out the exact recipe for the message your Ed25519 key must sign. ' +
        (o.notes?.challenge ? `${o.notes.challenge} ` : '') +
        'You always sign with your OWN key — nothing here custodies anything. Takes no parameters.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { challenge, expiresAt } = await o.generateChallenge();
        return {
          challenge,
          expiresAt: new Date(expiresAt).toISOString(),
          sign: {
            message: `blake2b-256 of: "R" (ascii) + challenge (hex-decoded) + one length byte of the dApp definition address "${o.dAppDefinitionAddress}" + that same address (utf-8) + the origin "${o.origin}" (utf-8)`,
            curve: 'curve25519 (Ed25519); sign the 32-byte hash, hex-encode the signature',
            address: 'your virtual account address, derived from your public key',
            ...o.notes?.sign,
            then: 'Call login with { challenge, address, publicKey, signature, curve }.',
          },
        };
      },
    },
    {
      name: 'login',
      title: 'Exchange a signed proof for a token',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        `Step 2: exchange the signed ROLA proof for a ${span(o.tokenTtlSec)} Bearer token — the same verification the human wallet flow runs. ` +
        `Send the returned token as an HTTP \`Authorization: Bearer <token>\` header on every later ${carries} call; tool arguments never carry it.`,
      inputSchema: {
        type: 'object',
        properties: {
          challenge: { type: 'string', description: 'The challenge from get_challenge' },
          address: { type: 'string', description: o.notes?.address ?? 'Your account address (virtual account of the signing key)' },
          publicKey: { type: 'string', description: 'Ed25519 public key, hex' },
          signature: { type: 'string', description: 'Signature over the ROLA message, hex' },
          curve: { type: 'string', enum: ['curve25519', 'secp256k1'], description: 'Signing curve (Ed25519 = "curve25519")' },
        },
        required: ['challenge', 'address', 'publicKey', 'signature', 'curve'],
      },
      handler: async args => {
        const signed: SignedChallenge = {
          challenge: String(args.challenge),
          address: String(args.address),
          proof: { publicKey: String(args.publicKey), signature: String(args.signature), curve: args.curve as SignedChallenge['proof']['curve'] },
        };
        try {
          const { token, expiresAt, ...rest } = await o.login(signed);
          return {
            token,
            tokenType: 'Bearer',
            expiresAt: new Date(expiresAt).toISOString(),
            ...rest,
            note: `Send as an HTTP \`Authorization: Bearer <token>\` header on the POSTs carrying your ${carries} calls.`,
          };
        } catch (err) {
          if (!(err instanceof McpToolError)) throw err;
          throw new McpToolError(err.message, {
            hint: `Challenges are single-use and expire after ${minutes} minutes — call get_challenge again. The signing recipe is in its response.`,
            ...err.details,
          });
        }
      },
    },
  ];
}
