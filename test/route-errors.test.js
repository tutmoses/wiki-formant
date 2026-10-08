import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, errors, HttpError, handleRoute } from 'wiki-formant/http';

test('every error answer is { error } with its status', async () => {
  const cases = [
    [errors.badRequest('q is required'), 400, 'q is required'],
    [errors.unauthorized(), 401, 'Unauthorized'],
    [errors.forbidden(), 403, 'Forbidden'],
    [errors.notFound(), 404, 'Not found'],
    [errors.internal(), 500, 'Internal server error'],
  ];
  for (const [res, status, error] of cases) {
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error });
  }
});

test('extra fields ride in the body without a second shape', async () => {
  assert.deepEqual(await errors.badRequest('bad', { code: 'INVALID_PARAMS' }).json(), { error: 'bad', code: 'INVALID_PARAMS' });
});

test('a 429 states its wait', () => {
  const res = errors.tooManyRequests(2.2);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '3');
});

test('json takes a status or a full init', async () => {
  assert.equal(json({ a: 1 }, 201).status, 201);
  assert.equal(json({ a: 1 }, { headers: { 'X-A': '1' } }).headers.get('x-a'), '1');
});

test('a thrown HttpError is its own answer', async () => {
  const res = await handleRoute(async () => { throw new HttpError(400, 'symptoms is required', { code: 'INVALID_PARAMS' }); });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'symptoms is required', code: 'INVALID_PARAMS' });
});

test('BUG: any other exception is a 500 that names nothing internal', async () => {
  // One handler echoed every exception's message, so a database error's text
  // reached the caller.
  const logged = console.error;
  console.error = () => {};
  try {
    const res = await handleRoute(async () => { throw new Error('relation "secret_table" does not exist'); }, 'Search failed');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Search failed' });
  } finally {
    console.error = logged;
  }
});
