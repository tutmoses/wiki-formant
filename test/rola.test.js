import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createRola, sessionSecret, signSession, verifySession, bearerToken, rolaLoginTools } from 'wiki-formant/rola';
import { McpToolError } from 'wiki-formant/mcp';

// prisma.challenge, as far as this module reaches into it.
function memoryChallenges() {
  const rows = new Map();
  return {
    rows,
    async create({ data }) { rows.set(data.challenge, data.expiresAt); },
    async deleteMany({ where: { challenge, expiresAt } }) {
      let count = 0;
      for (const [c, at] of rows) {
        if (challenge !== undefined && c !== challenge) continue;
        if ('lt' in expiresAt ? at < expiresAt.lt : at > expiresAt.gt) { rows.delete(c); count++; }
      }
      return { count };
    },
  };
}

const identity = {
  expectedOrigin: 'https://example.com',
  dAppDefinitionAddress: 'account_rdx1test',
  networkId: 1,
  applicationName: 'Test',
};
const proof = { publicKey: 'aa', signature: 'bb', curve: 'curve25519' };

test('a challenge is 32 random bytes in hex, and generating purges expired ones', async () => {
  const challenges = memoryChallenges();
  challenges.rows.set('stale', new Date(Date.now() - 1000));
  const rola = createRola({ ...identity, challenges });
  const { challenge, expiresAt } = await rola.generateChallenge();
  assert.match(challenge, /^[0-9a-f]{64}$/);
  assert.ok(expiresAt.getTime() - Date.now() > 290_000);
  assert.deepEqual([...challenges.rows.keys()], [challenge]);
});

test('a challenge verifies once: unknown, expired and replayed ones are refused', async () => {
  const challenges = memoryChallenges();
  const rola = createRola({ ...identity, challenges });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(
      await rola.verifySignedChallenge({ challenge: 'nope', address: 'account_rdx1a', proof }),
      { isValid: false, error: 'Invalid or expired challenge' },
    );
    challenges.rows.set('old', new Date(Date.now() - 1));
    assert.equal((await rola.verifySignedChallenge({ challenge: 'old', address: 'account_rdx1a', proof })).isValid, false);

    // A persona proof spends the challenge and is refused, so it cannot be retried as an account.
    const { challenge } = await rola.generateChallenge();
    assert.deepEqual(
      await rola.verifySignedChallenge({ challenge, address: 'identity_rdx1p', proof }),
      { isValid: false, error: 'Sign in with an account proof' },
    );
    assert.deepEqual(
      await rola.verifySignedChallenge({ challenge, address: 'account_rdx1a', proof }),
      { isValid: false, error: 'Invalid or expired challenge' },
    );
  } finally {
    console.error = quiet;
  }
});

test('a body with no challenge string spends no one else\'s challenge', async () => {
  const challenges = memoryChallenges();
  const rola = createRola({ ...identity, challenges });
  const { challenge } = await rola.generateChallenge();
  await rola.generateChallenge();
  for (const signed of [{ address: 'account_rdx1a', proof }, { challenge: { not: '' }, address: 'account_rdx1a', proof }, {}]) {
    assert.equal((await rola.verifySignedChallenge(signed)).isValid, false);
  }
  assert.equal(challenges.rows.size, 2);
  assert.ok(challenges.rows.has(challenge));
});

test('a session token round-trips its claims, and anything but HS256 under the secret is refused', async () => {
  const secret = sessionSecret('x'.repeat(32));
  const token = await signSession({ id: 'account_rdx1a' }, secret, 60);
  const claims = await verifySession(token, secret);
  assert.equal(claims?.id, 'account_rdx1a');
  assert.ok(claims?.jti && claims.exp - claims.iat === 60);

  assert.equal(await verifySession(token, sessionSecret('y'.repeat(32))), null);
  const hs512 = await new SignJWT({ id: 'x' }).setProtectedHeader({ alg: 'HS512' }).setExpirationTime('1m').sign(secret);
  assert.equal(await verifySession(hs512, secret), null);
  const expired = await new SignJWT({ id: 'x' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(secret);
  assert.equal(await verifySession(expired, secret), null);
});

test('a short or missing secret refuses to start', () => {
  assert.throws(() => sessionSecret(undefined), /32 characters/);
  assert.throws(() => sessionSecret('short'), /32 characters/);
});

test('bearerToken reads the Authorization header in any case', () => {
  assert.equal(bearerToken(new Headers({ Authorization: 'Bearer abc.def' })), 'abc.def');
  assert.equal(bearerToken(new Headers({ authorization: 'bearer  abc' })), 'abc');
  assert.equal(bearerToken(new Headers({ Authorization: 'Basic abc' })), null);
  assert.equal(bearerToken(new Headers()), null);
});

test('rolaLoginTools: the challenge names the dApp and the origin, and a refused login says to start again', async () => {
  const expiresAt = new Date('2026-11-01T00:05:00Z');
  const [challenge, login] = rolaLoginTools({
    site: 'Caper',
    dAppDefinitionAddress: 'account_tdx_dapp',
    origin: 'https://caper.network',
    generateChallenge: async () => ({ challenge: 'ab', expiresAt }),
    login: async signed => {
      if (signed.proof.signature !== 'good') throw new McpToolError('Invalid signature');
      return { token: 't', expiresAt, walletAddress: signed.address };
    },
    tokenTtlSec: 12 * 3600,
    notes: { challenge: 'Writes are Stokenet-testnet only for now.', sign: { deriveAddress: 'bech32m …' } },
  });
  assert.deepEqual([challenge.name, login.name], ['get_challenge', 'login']);
  assert.match(challenge.description, /^Step 1 of writing to Caper: .*\(5-minute expiry\).*Stokenet-testnet only for now\. You always sign/);
  assert.match(login.description, /a 12h Bearer token/);

  const issued = await challenge.handler({}, {});
  assert.equal(issued.expiresAt, '2026-11-01T00:05:00.000Z');
  assert.match(issued.sign.message, /"account_tdx_dapp".*"https:\/\/caper\.network"/);
  assert.deepEqual(Object.keys(issued.sign), ['message', 'curve', 'address', 'deriveAddress', 'then']);

  const args = { challenge: 'ab', address: 'account_tdx_me', publicKey: 'aa', curve: 'curve25519' };
  const ok = await login.handler({ ...args, signature: 'good' }, {});
  assert.deepEqual({ ...ok, note: undefined }, { token: 't', tokenType: 'Bearer', expiresAt: '2026-11-01T00:05:00.000Z', walletAddress: 'account_tdx_me', note: undefined });
  await assert.rejects(login.handler({ ...args, signature: 'bad' }, {}), err => err instanceof McpToolError && err.message === 'Invalid signature' && /call get_challenge again/.test(err.details.hint));
});
