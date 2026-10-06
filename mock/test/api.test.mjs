// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, FILE_SIZE, partBytes, withMock } from './helpers.mjs';

const OPEN = { account: { balance_seconds: 36000 } };

/**
 * @param {Parameters<Parameters<typeof withMock>[0]>[0]} m
 * @param {unknown} mock
 * @param {unknown} [expect]
 */
async function select(m, mock, expect) {
  const res = await m.api('POST', '/__scenario', { json: { mock, expect }, auth: false });
  assert.equal(res.status, 200);
}

/**
 * @param {Parameters<Parameters<typeof withMock>[0]>[0]} m
 * @param {string} key
 */
async function uploadedJob(m, key) {
  const create = (await createJob(m.api, { key })).json;
  const parts = [];
  for (const part of create.upload.part_urls) {
    const res = await fetch(part.url, { method: 'PUT', body: partBytes(create.upload, part.n) });
    parts.push({ n: part.n, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') });
  }
  const done = await m.api('POST', `/v1/uploads/${create.job_id}/complete`, { json: { parts } });
  return { id: create.job_id, complete: done.json };
}

test('jobs: default flow, phases by polls and by clock, failure fields, uploading before complete', async () => {
  await withMock(async (m) => {
    await select(m, {
      ...OPEN,
      jobFlow: [
        { state: 'queued', polls: 2 },
        { state: 'processing', untilClock: 100 },
        { state: 'failed', error: 'bad audio', failure_kind: 'media_unreadable' },
      ],
    });
    const create = (await createJob(m.api)).json;
    assert.equal((await m.api('GET', `/v1/jobs/${create.job_id}`)).json.state, 'uploading');
    const { id } = await uploadedJob(m, 'flow-key-00000000000');
    const states = [];
    for (let i = 0; i < 3; i++) states.push((await m.api('GET', `/v1/jobs/${id}`)).json.state);
    assert.deepEqual(states, ['queued', 'queued', 'processing']);
    assert.equal((await m.api('GET', `/v1/jobs/${id}`)).json.state, 'processing');
    await m.advance(100);
    const failed = (await m.api('GET', `/v1/jobs/${id}`)).json;
    assert.deepEqual([failed.state, failed.error, failed.failure_kind, failed.transcript_id], ['failed', 'bad audio', 'media_unreadable', null]);
    assert.deepEqual(Object.keys(failed).sort(), [
      'actual_seconds', 'billable_seconds', 'created_at', 'declared_seconds', 'error', 'failure_kind', 'id', 'mode',
      'options', 'private_result_available', 'private_result_expires_at', 'retry_of', 'state', 'transcript_id', 'verified_seconds',
    ]);
    assert.equal((await m.api('GET', '/v1/jobs/job_missing')).status, 404);
  });
});

test('jobs: done assigns a transcript id and the transcript fixture is served under it', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, fixture: 'multi-renamed' });
    const { id } = await uploadedJob(m, 'done-key-000000000000');
    const states = [(await m.api('GET', `/v1/jobs/${id}`)).json.state, (await m.api('GET', `/v1/jobs/${id}`)).json];
    assert.equal(states[0], 'processing');
    const job = /** @type {{ state: string, transcript_id: string }} */ (states[1]);
    assert.equal(job.state, 'done');
    const transcript = (await m.api('GET', `/v1/transcripts/${job.transcript_id}`)).json;
    assert.equal(transcript.id, job.transcript_id);
    assert.equal(transcript.body.original.utterances.length, 10);
    assert.deepEqual(Object.keys(transcript).sort(), [
      'auto_delete_at', 'body', 'client_code', 'created_at', 'duration_seconds', 'edited', 'id', 'language_detected',
      'matter_code', 'speaker_names', 'tags', 'title', 'updated_at',
    ]);
    assert.equal((await m.api('GET', '/v1/transcripts/tr_unknown')).status, 404);
  });
});

test('jobs list: active filter and cursor', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    await createJob(m.api);
    await uploadedJob(m, 'second-job-key-00000');
    const all = (await m.api('GET', '/v1/jobs')).json;
    assert.equal(all.jobs.length, 2);
    assert.equal(all.next_cursor, null);
    const paged = (await m.api('GET', '/v1/jobs?limit=1')).json;
    assert.equal(paged.jobs.length, 1);
    assert.match(paged.next_cursor, /^cur_/);
    assert.equal((await m.api('GET', `/v1/jobs?limit=1&cursor=${paged.next_cursor}`)).json.jobs[0].id, 'job_conf_0002');
  });
});

test('transcripts list: cursor paging over 120 rows, limit clamp, forged cursor refused', async () => {
  await withMock(async (m) => {
    await select(m, { listing: { count: 120 } });
    const first = (await m.api('GET', '/v1/transcripts')).json;
    assert.equal(first.transcripts.length, 50);
    assert.equal(first.transcripts[0].id, 'tr_list_001');
    assert.deepEqual(Object.keys(first.transcripts[0]).sort(), [
      'auto_delete_at', 'created_at', 'duration_seconds', 'id', 'insights_state', 'language_detected', 'options', 'tags', 'title',
    ]);
    const second = (await m.api('GET', `/v1/transcripts?cursor=${first.next_cursor}`)).json;
    const third = (await m.api('GET', `/v1/transcripts?cursor=${second.next_cursor}`)).json;
    assert.deepEqual([second.transcripts.length, third.transcripts.length, third.next_cursor], [50, 20, null]);
    assert.equal(third.transcripts.at(-1).id, 'tr_list_120');
    assert.equal((await m.api('GET', '/v1/transcripts?limit=500')).json.transcripts.length, 100);
    assert.equal((await m.api('GET', '/v1/transcripts?cursor=cur_MA.000000000000')).json.error, 'bad_request');
    assert.equal((await m.api('GET', '/v1/transcripts?cursor=abc')).status, 400);
    assert.equal((await m.api('GET', '/v1/transcripts?limit=0')).status, 400);
    assert.equal((await m.api('GET', '/v1/transcripts/tr_list_007')).json.title, 'Synthetic 007');
    assert.equal((await m.api('GET', '/v1/transcripts/tr_list_121')).status, 404);
    assert.deepEqual((await m.api('GET', '/v1/transcripts/deleted')).json, { deleted: [], next_cursor: null });
  });
});

test('forwardCompat: unknown fields appear on create, complete, job, account and transcript', async () => {
  await withMock(async (m) => {
    await select(m, {
      ...OPEN,
      forwardCompat: true,
      completeState: 'done',
    });
    const create = (await createJob(m.api)).json;
    assert.deepEqual(create.x_unknown_field, { nested: true, list: [1, 2, 3] });
    assert.ok((await m.api('GET', '/v1/account')).json.x_unknown_field);
    const parts = [];
    for (const part of create.upload.part_urls) {
      const res = await fetch(part.url, { method: 'PUT', body: partBytes(create.upload, part.n) });
      parts.push({ n: part.n, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') });
    }
    const done = (await m.api('POST', `/v1/uploads/${create.job_id}/complete`, { json: { parts } })).json;
    assert.ok(done.x_unknown_field);
    const job = (await m.api('GET', `/v1/jobs/${create.job_id}`)).json;
    assert.ok(job.x_unknown_field);
    const transcript = (await m.api('GET', `/v1/transcripts/${job.transcript_id}`)).json;
    assert.ok(transcript.x_unknown_field);
    assert.ok(transcript.body.x_unknown_field);
    assert.equal(transcript.body.original.utterances[0].confidence, 0.9);
    assert.equal(FILE_SIZE > 0, true);
  });
});

test('account and billing: account shape, packs, cards, purchase with replay, default card', async () => {
  await withMock(async (m) => {
    await select(m, { account: { balance_seconds: 0, agent: true } });
    const account = (await m.api('GET', '/v1/account')).json;
    assert.deepEqual(Object.keys(account).sort(), ['balance_seconds', 'card_on_file', 'credits_expire_at', 'data_region', 'held_seconds', 'limits', 'purchases_remaining_in_window']);
    const packs = (await m.api('GET', '/v1/billing/packs')).json.packs;
    assert.deepEqual(packs.map((/** @type {{ id: string }} */ p) => p.id), ['45min', '300min', '900min', '1800min', '6000min']);
    assert.deepEqual(packs.map((/** @type {{ available: boolean }} */ p) => p.available), [true, true, false, false, false]);
    const cards = (await m.api('GET', '/v1/billing/cards')).json;
    assert.equal(cards.default_id, 'pm_conf_default');
    assert.equal(cards.methods.length, 2);

    const buy = { pack: '300min', idempotency_key: 'buy-1', quick_payment_method_id: 'pm_conf_default', policy_ack: false };
    assert.deepEqual((await m.api('POST', '/v1/billing/purchase', { json: buy })).json, { status: 'ok', balance_seconds: 18000 });
    assert.deepEqual((await m.api('POST', '/v1/billing/purchase', { json: buy })).json, { status: 'ok', balance_seconds: 18000 });
    assert.equal((await m.api('GET', '/__state', { auth: false })).json.purchases.length, 1);
    assert.equal((await m.api('POST', '/v1/billing/purchase', { json: { ...buy, idempotency_key: 'bad key!' } })).json.error, 'invalid_idempotency_key');
    assert.equal((await m.api('POST', '/v1/billing/purchase', { json: { ...buy, idempotency_key: 'b2', pack: '7min' } })).json.error, 'unknown_pack');
    assert.equal((await m.api('POST', '/v1/billing/purchase', { json: { ...buy, idempotency_key: 'b3', quick_payment_method_id: 'pm_x' } })).json.error, 'no_payment_method');

    assert.deepEqual((await m.api('POST', '/v1/billing/cards/default', { json: { payment_method_id: 'pm_conf_other' } })).json, { ok: true });
    assert.equal((await m.api('GET', '/v1/billing/cards')).json.default_id, 'pm_conf_other');
    assert.equal((await m.api('POST', '/v1/billing/cards/default', { json: { payment_method_id: 'pm_x' } })).status, 404);
    const setup = (await m.api('POST', '/v1/billing/setup-session', { json: {} })).json;
    assert.deepEqual(Object.keys(setup).sort(), ['checkout_url', 'expires_at', 'session_id']);
  });
});

test('agent: signup checks terms and pack, claim works once, rotate returns a new token', async () => {
  await withMock(async (m) => {
    const body = { contact_email: 'a@example.com', pack_id: '45min', accept_terms_version: '2026-10-01', agent: { name: 'bot', platform: 'test' } };
    const stale = await m.api('POST', '/v1/agent/accounts', { json: { ...body, accept_terms_version: 'old' }, auth: false });
    assert.deepEqual(stale.json, { error: 'policy_version_stale', code: 1043, details: { current_version: '2026-10-01' } });
    assert.equal((await m.api('POST', '/v1/agent/accounts', { json: { ...body, pack_id: '900min' }, auth: false })).json.error, 'agent_pack_locked');
    const signup = (await m.api('POST', '/v1/agent/accounts', { json: body, auth: false })).json;
    assert.deepEqual(Object.keys(signup).sort(), ['amount', 'checkout_url', 'claim_secret', 'currency', 'expires_at', 'pack', 'signup_id']);

    const path = `/v1/agent/accounts/${signup.signup_id}/claim`;
    assert.equal((await m.api('POST', path, { json: { claim_secret: 'wrong' }, auth: false })).json.code, 4036);
    const claim = (await m.api('POST', path, { json: { claim_secret: signup.claim_secret }, auth: false })).json;
    assert.deepEqual(Object.keys(claim).sort(), ['balance_seconds', 'pat', 'scopes', 'user_id']);
    assert.equal(claim.balance_seconds, 2700);
    assert.equal((await m.api('POST', path, { json: { claim_secret: signup.claim_secret }, auth: false })).json.error, 'agent_claim_invalid');
    const seeded = await m.api('POST', '/v1/agent/accounts/sg_conformance/claim', { json: { claim_secret: 'cs_conformance_secret' }, auth: false });
    assert.equal(seeded.status, 200);
    const rotate = (await m.api('POST', '/v1/agent/credentials/rotate')).json;
    assert.deepEqual(Object.keys(rotate).sort(), ['pat', 'pat_id', 'scopes']);
    assert.equal((await m.api('GET', '/__state', { auth: false })).json.rotations, 1);
  });
});

test('verify: every expectation kind passes and fails as it should', async () => {
  await withMock(async (m) => {
    const verify = async () => (await m.api('GET', '/__verify', { auth: false })).json;
    await select(m, OPEN, {
      requests: { 'GET /v1/account': 2 },
      requestsAtLeast: { 'GET /v1/account': 1 },
      requestsAtMost: { 'GET /v1/billing/packs': 0 },
      authorization: { 'GET /v1/account': 'present' },
      queries: { 'GET /v1/transcripts': [{ cursor: '*' }] },
      state: { jobs: 0, purchases: [] },
      sameIdempotencyKey: 'POST /v1/uploads',
    });
    await m.api('GET', '/v1/account');
    await m.api('GET', '/v1/account');
    await m.api('GET', '/v1/transcripts?cursor=zzz');
    const bad = await verify();
    assert.equal(bad.ok, false);
    assert.equal(bad.failures.length, 1);
    assert.match(bad.failures.join('\n'), /no requests to compare keys/);

    await select(m, OPEN, { authorization: { 'GET /v1/account': 'absent' }, requests: { 'GET /v1/account': 1 }, requestsAtLeast: { 'GET /v1/account': 3 }, requestsAtMost: { 'GET /v1/account': 0 } });
    await m.api('GET', '/v1/account');
    assert.equal((await verify()).failures.length, 3);

    await select(m, OPEN, { noRequests: true });
    await m.api('GET', '/v1/account');
    assert.equal((await verify()).ok, false);
    await m.api('POST', '/__mark', { auth: false });
    assert.equal((await verify()).ok, true);

    await select(m, OPEN, { sameIdempotencyKey: 'POST /v1/uploads', requests: { 'POST /v1/uploads': 2 } });
    await createJob(m.api);
    await createJob(m.api);
    assert.equal((await verify()).ok, true);
    await createJob(m.api, { key: 'other-key-00000000000' });
    assert.match((await verify()).failures.join('\n'), /keys differ/);
  });
});

test('verify: heartbeat cadence uses mock time from create to complete', async () => {
  await withMock(async (m) => {
    const expect = { heartbeat: { maxGapSeconds: 120, minCount: 2 } };
    await select(m, OPEN, expect);
    const id = (await createJob(m.api)).json.job_id;
    await m.advance(120);
    await m.api('POST', `/v1/uploads/${id}/heartbeat`);
    await m.advance(121);
    await m.api('POST', `/v1/uploads/${id}/heartbeat`);
    assert.match((await m.api('GET', '/__verify', { auth: false })).json.failures.join(), /gap of 121 s/);
    await select(m, OPEN, expect);
    const id2 = (await createJob(m.api)).json.job_id;
    for (let i = 0; i < 3; i++) {
      await m.advance(100);
      await m.api('POST', `/v1/uploads/${id2}/heartbeat`);
    }
    assert.deepEqual((await m.api('GET', '/__verify', { auth: false })).json, { ok: true, failures: [] });
  });
});
