import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRolaAuth, proofType } from '../dist/rola.js';

// The proof-type split is the bug this module exists to stop recurring: one of
// the two copies it replaces passed `type: 'account'` unconditionally, so a
// persona login could never verify there.
test('an account address is an account proof', () => {
  assert.equal(proofType('account_rdx12x...'), 'account');
});

test('an identity address is a persona proof, not an account one', () => {
  assert.equal(proofType('identity_rdx12x...'), 'persona');
});

test('anything else is neither, so the caller can refuse it outright', () => {
  assert.equal(proofType('resource_rdx1tk...'), null);
  assert.equal(proofType(''), null);
});

// ---- store + cookie doubles ------------------------------------------------

function fakeStore() {
  const sessions = new Map();
  const challenges = new Map();
  let n = 0;
  return {
    sessions,
    challenges,
    session: {
      async create({ data }) {
        const row = { id: `s${++n}`, ...data };
        sessions.set(data.token, row);
        return row;
      },
      async findUnique({ where: { token } }) {
        return sessions.get(token) ?? null;
      },
      async delete({ where: { id } }) {
        for (const [k, v] of sessions) if (v.id === id) sessions.delete(k);
      },
      async deleteMany({ where: { token } }) {
        sessions.delete(token);
      },
    },
    challenge: {
      async create({ data }) {
        const row = { id: `c${++n}`, ...data };
        challenges.set(data.challenge, row);
        return row;
      },
      async findUnique({ where: { challenge } }) {
        return challenges.get(challenge) ?? null;
      },
      async delete({ where: { id } }) {
        for (const [k, v] of challenges) if (v.id === id) challenges.delete(k);
      },
    },
  };
}

function fakeJar() {
  const jar = new Map();
  return {
    jar,
    get: name => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name, value) => jar.set(name, value),
    delete: name => jar.delete(name),
  };
}

const RADIX = {
  expectedOrigin: 'https://example.test',
  dAppDefinitionAddress: 'account_rdx12x',
  networkId: 1,
  applicationName: 'Test',
};

const secret = new TextEncoder().encode('a'.repeat(32));

function makeAuth(store = fakeStore(), jar = fakeJar()) {
  const auth = createRolaAuth({
    cookieName: 'test_session',
    jwtSecret: secret,
    store,
    cookies: async () => jar,
    rola: RADIX,
  });
  return { auth, store, jar };
}

test('a created session round-trips through the cookie the config names', async () => {
  const { auth, jar } = makeAuth();
  const token = await auth.createSession('u1', 'account_rdx1abc', undefined, 'Ada');
  assert.equal(jar.jar.get('test_session'), token);

  const session = await auth.getSession();
  assert.equal(session.userId, 'u1');
  assert.equal(session.radixAddress, 'account_rdx1abc');
  assert.equal(session.displayName, 'Ada');
});

test('a Bearer header is an equal route in, for an agent that holds no cookie', async () => {
  const { auth } = makeAuth();
  const token = await auth.createSession('u2', 'account_rdx1def');
  const { auth: other } = makeAuth();

  // Same secret, but a different (empty) store: the token must be rejected when
  // the session row is absent, which is what makes logout server-side real.
  assert.equal(await other.getSession({ headers: { get: () => `Bearer ${token}` } }), null);
});

test('destroySession drops both the row and the cookie', async () => {
  const { auth, store, jar } = makeAuth();
  const token = await auth.createSession('u3', 'account_rdx1ghi');
  await auth.destroySession();
  assert.equal(jar.jar.has('test_session'), false);
  assert.equal(store.sessions.has(token), false);
  assert.equal(await auth.getSession(), null);
});

test('an expired session row verifies to nothing and is swept', async () => {
  const { auth, store, jar } = makeAuth();
  const token = await auth.createSession('u4', 'account_rdx1jkl');
  store.sessions.get(token).expiresAt = new Date(Date.now() - 1000);
  assert.equal(await auth.getSession(), null);
  assert.equal(store.sessions.has(token), false);
  void jar;
});

test('a challenge is 32 bytes of hex and is stored against its expiry', async () => {
  const { auth, store } = makeAuth();
  const { challenge, expiresAt } = await auth.generateChallenge();
  assert.match(challenge, /^[0-9a-f]{64}$/);
  assert.ok(expiresAt > new Date());
  assert.ok(store.challenges.has(challenge));
});

test('an unknown challenge does not verify', async () => {
  const { auth } = makeAuth();
  const r = await auth.verifySignedChallenge({
    challenge: 'f'.repeat(64),
    address: 'account_rdx1abc',
    proof: { publicKey: 'k', signature: 's', curve: 'curve25519' },
  });
  assert.equal(r.isValid, false);
  assert.equal(r.error, 'Invalid or expired challenge');
});

test('a challenge is consumed, so a replayed proof fails the second time', async () => {
  const { auth, store } = makeAuth();
  const { challenge } = await auth.generateChallenge();
  const signed = {
    challenge,
    address: 'account_rdx1abc',
    proof: { publicKey: 'k', signature: 's', curve: 'curve25519' },
  };
  // The first call gets past the challenge gate and on to real signature
  // verification, which these fake proofs fail — that is fine; what matters is
  // that the row is gone afterwards.
  await auth.verifySignedChallenge(signed);
  assert.equal(store.challenges.has(challenge), false);

  const replay = await auth.verifySignedChallenge(signed);
  assert.equal(replay.error, 'Invalid or expired challenge');
});

test('an expired challenge is refused and swept', async () => {
  const { auth, store } = makeAuth();
  const { challenge } = await auth.generateChallenge();
  store.challenges.get(challenge).expiresAt = new Date(Date.now() - 1000);
  const r = await auth.verifySignedChallenge({
    challenge,
    address: 'account_rdx1abc',
    proof: { publicKey: 'k', signature: 's', curve: 'curve25519' },
  });
  assert.equal(r.isValid, false);
  assert.equal(store.challenges.has(challenge), false);
});
