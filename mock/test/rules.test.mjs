// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
/** @typedef {import('./helpers.mjs').Mock} Mock */
import { TEST_TOKEN, createJob, select, withMock } from './helpers.mjs';

/**
 * @param {(m: Mock) => Promise<void>} fn
 * @param {unknown} mock
 */
function withRules(fn, mock) {
  return withMock(async (m) => {
    await select(m, mock);
    await fn(m);
  });
}

test('rules: injected statuses are consumed in order, then the route behaves normally', async () => {
  await withRules(
    async ({ api }) => {
      const first = await api('GET', '/v1/account');
      assert.equal(first.status, 502);
      assert.equal(first.text, 'Bad Gateway');
      assert.match(first.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal((await api('GET', '/v1/account')).status, 429);
      assert.equal((await api('GET', '/v1/account')).status, 200);
      assert.equal((await api('GET', '/v1/account')).status, 200);
    },
    {
      balance: [
        { status: 502 },
        { status: 429, error: 'rate_limited', headers: { 'Retry-After': '61' } },
        { status: 200 },
      ],
    },
  );
});

test('rules: error slugs carry the catalog code and status, extra keys and headers', async () => {
  await withRules(
    async ({ api }) => {
      const res = await api('GET', '/v1/account');
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '61');
      assert.deepEqual(res.json, { error: 'rate_limited', code: 5000, limits: { max: 1 } });
      assert.equal(res.headers.get('retry-after'), '61');
    },
    { balance: [{ error: 'rate_limited', headers: { 'Retry-After': '61' }, extra: { limits: { max: 1 } } }] },
  );
});

test('rules: times and always', async () => {
  await withRules(
    async ({ api }) => {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await api('GET', '/v1/account')).status);
      assert.deepEqual(codes, [500, 500, 200, 200]);
      const packs = [];
      for (let i = 0; i < 3; i++) packs.push((await api('GET', '/v1/billing/packs')).status);
      assert.deepEqual(packs, [503, 503, 503]);
    },
    { balance: [{ status: 500, times: 2 }], packs: [{ status: 503, times: 'always' }] },
  );
});

test('rules: match on part number and on a prior direct success', async () => {
  await withRules(
    async ({ api }) => {
      const create = await createJob(api, { size: 30 });
      const { job_id: id, upload } = create.json;
      const [one, two, three] = upload.part_urls;
      const put = (/** @type {{ url: string }} */ part) => fetch(part.url, { method: 'PUT', body: new Uint8Array(10) });
      assert.equal((await put(two)).status, 500);
      assert.equal((await put(two)).status, 200);
      assert.equal((await put(one)).status, 503);
      assert.equal((await put(one)).status, 200);
      assert.equal((await put(three)).status, 200);
      assert.equal(id, 'job_conf_0001');
    },
    {
      account: { balance_seconds: 1000 },
      r2: [
        { match: { n: 2 }, status: 500 },
        { match: { afterDirectSuccess: true }, status: 503 },
      ],
    },
  );
});

test('rules: drop after-read sends no response and commits nothing; after-commit commits', async () => {
  await withRules(
    async ({ api }) => {
      await assert.rejects(api('POST', '/v1/agent/credentials/rotate'));
      assert.equal((await api('GET', '/__state', { auth: false })).json.rotations, 0);
      await assert.rejects(createJob(api));
      const state = (await api('GET', '/__state', { auth: false })).json;
      assert.equal(state.jobs, 1);
      assert.equal(state.holds, 1);
      const replay = await createJob(api);
      assert.equal(replay.status, 200);
      assert.equal((await api('GET', '/__state', { auth: false })).json.jobs, 1);
    },
    { account: { balance_seconds: 1000 }, rotate: [{ drop: 'after-read' }], create: [{ drop: 'after-commit' }] },
  );
});

test('rules: echoToken puts the received bearer token in the error body', async () => {
  await withRules(
    async ({ api }) => {
      const res = await api('GET', '/v1/account');
      assert.equal(res.status, 401);
      assert.equal(res.json.error, 'unauthorized');
      assert.ok(res.text.includes(TEST_TOKEN));
    },
    { balance: [{ status: 401, error: 'unauthorized', echoToken: true }] },
  );
});

test('auth: missing, malformed and rotated-away tokens get unauthorized', async () => {
  await withMock(async ({ api }) => {
    const none = await api('GET', '/v1/account', { auth: false });
    assert.deepEqual(none.json, { error: 'unauthorized', code: 2000 });
    assert.equal(
      (await api('GET', '/v1/account', { auth: false, headers: { authorization: 'Bearer nope' } })).status,
      401,
    );
    const rotated = await api('POST', '/v1/agent/credentials/rotate');
    assert.equal(rotated.status, 200);
    assert.match(rotated.json.pat, /^hsr1:eu:pat\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    assert.equal((await api('GET', '/v1/account')).status, 401);
    const fresh = await api('GET', '/v1/account', {
      auth: false,
      headers: { authorization: `Bearer ${rotated.json.pat}` },
    });
    assert.equal(fresh.status, 200);
  });
});

test('routes: unknown paths and methods answer with API-shaped errors and are logged', async () => {
  await withMock(async ({ api }) => {
    assert.deepEqual((await api('GET', '/v1/nope')).json, { error: 'not_found', code: 4000 });
    assert.equal((await api('DELETE', '/v1/account')).status, 405);
    const log = (await api('GET', '/__log', { auth: false })).json;
    assert.equal(log[0].route, 'GET (unmatched)');
  });
});

test('rules: unknown rule keys, unknown match keys and non-object steps fail the load', async () => {
  await withMock(async ({ api }) => {
    for (const [mock, text] of /** @type {[unknown, string][]} */ ([
      [{ r2: [{ afterDirectSuccess: true, status: 503 }] }, 'unknown rule key'],
      [{ r2: [{ match: { part: 2 }, status: 503 }] }, 'unknown match key'],
      [{ r2: [{ match: 'n=2', status: 503 }] }, 'match must be an object'],
      [{ r2: ['503'] }, 'must be an object'],
    ])) {
      const res = await api('POST', '/__scenario', { json: { mock }, auth: false });
      assert.equal(res.status, 400);
      assert.ok(res.text.includes(text), `${text}: ${res.text}`);
    }
  });
});

test('auth: an unauthenticated request does not consume a scripted step', async () => {
  await withRules(
    async ({ api }) => {
      assert.equal((await api('GET', '/v1/account', { auth: false })).status, 401);
      assert.equal((await api('GET', '/v1/account', { auth: false })).status, 401);
      assert.equal((await api('GET', '/v1/account')).status, 503);
      assert.equal((await api('GET', '/v1/account')).status, 200);
    },
    { balance: [{ status: 503 }] },
  );
});
