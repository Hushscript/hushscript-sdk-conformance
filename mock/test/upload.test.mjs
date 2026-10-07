// @ts-check
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { FILE_SIZE, createJob, partBytes, select, withMock } from './helpers.mjs';

const OPEN = { account: { balance_seconds: 36000 } };

/**
 * @param {{ part_size_bytes: number, part_urls: { n: number, url: string }[] }} upload
 * @param {{ n: number, url: string }} part
 */
async function putPart(upload, part) {
  const body = partBytes(upload, part.n);
  const res = await fetch(part.url, { method: 'PUT', body });
  return { res, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') };
}

test('create: validation, balance hold and idempotent replay', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    const { api } = m;
    assert.equal(
      (await api('POST', '/v1/uploads', { json: { size_bytes: 0, duration_seconds: 21 } })).json.error,
      'size_out_of_range',
    );
    assert.equal(
      (await api('POST', '/v1/uploads', { json: { size_bytes: 10, duration_seconds: 14 } })).json.error,
      'duration_out_of_range',
    );
    assert.equal((await api('POST', '/v1/uploads', { json: { size_bytes: 10, duration_seconds: 36001 } })).status, 422);
    assert.equal(
      (await api('POST', '/v1/uploads', { json: { size_bytes: 10, duration_seconds: 20, idempotency_key: 'short' } }))
        .json.code,
      1040,
    );
    assert.equal((await api('POST', '/v1/uploads', { body: 'not json' })).json.error, 'bad_request');

    const first = await createJob(api);
    assert.deepEqual(Object.keys(first.json).sort(), [
      'balance_seconds',
      'funding',
      'held_seconds',
      'job_id',
      'limits',
      'state',
      'upload',
    ]);
    assert.equal(first.json.balance_seconds, 36000 - 21);
    assert.equal(first.json.held_seconds, 21);
    assert.equal(first.json.state, 'uploading');
    assert.deepEqual(Object.keys(first.json.limits).sort(), [
      'active_jobs',
      'max_active_jobs',
      'max_daily_seconds',
      'used_today_seconds',
    ]);
    assert.deepEqual(Object.keys(first.json.upload).sort(), [
      'next_part_number',
      'part_size_bytes',
      'part_urls',
      'total_parts',
    ]);

    const replay = await createJob(api);
    assert.equal(replay.json.job_id, first.json.job_id);
    assert.equal(replay.json.held_seconds, 21);
    const other = await createJob(api, { key: 'a-different-key-0000' });
    assert.notEqual(other.json.job_id, first.json.job_id);
    assert.equal((await api('GET', '/__state', { auth: false })).json.jobs, 2);
  });
});

test('create: 402 with details when the balance is short, 429 at the active-job cap', async () => {
  await withMock(async (m) => {
    await select(m, { account: { balance_seconds: 10, held_seconds: 4 } });
    const short = await createJob(m.api);
    assert.equal(short.status, 402);
    assert.deepEqual(short.json, {
      error: 'insufficient_balance',
      code: 3001,
      needed_seconds: 21,
      balance_seconds: 10,
      held_seconds: 4,
    });
    await select(m, { account: { balance_seconds: 36000, max_active_jobs: 1 } });
    await createJob(m.api);
    const capped = await createJob(m.api, { key: 'another-key-1234567' });
    assert.deepEqual(capped.json, { error: 'too_many_active_jobs', code: 5001 });
    assert.equal(capped.headers.get('retry-after'), null);
  });
});

test('parts: 16 URLs per page, start paging, bad start, part count follows the scenario', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, upload: { parts: 40 } });
    const create = await createJob(m.api);
    const upload = create.json.upload;
    assert.equal(upload.total_parts, 40);
    assert.equal(upload.part_urls.length, 16);
    assert.equal(upload.next_part_number, 17);
    assert.ok(Math.ceil(FILE_SIZE / upload.part_size_bytes) === 40);
    const id = create.json.job_id;
    const second = (await m.api('GET', `/v1/uploads/${id}/part-urls?start=17`)).json;
    assert.deepEqual([second.part_urls[0].n, second.part_urls.length, second.next_part_number], [17, 16, 33]);
    const third = (await m.api('GET', `/v1/uploads/${id}/part-urls?start=33`)).json;
    assert.deepEqual([third.part_urls.length, third.next_part_number], [8, null]);
    assert.equal((await m.api('GET', `/v1/uploads/${id}/part-urls?start=41`)).json.error, 'bad_part_number');
    assert.equal((await m.api('GET', `/v1/uploads/${id}/part-urls?start=0`)).status, 400);
    assert.equal((await m.api('GET', '/v1/uploads/job_missing/part-urls')).status, 404);
  });
});

test('upload config: nullPartUrls nulls part_urls on the create answer or on the pages', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, upload: { nullPartUrls: 'create' } });
    const create = await createJob(m.api);
    assert.deepEqual(
      [create.json.upload.part_urls, create.json.upload.next_part_number, create.json.upload.total_parts],
      [null, null, 3],
    );
    await select(m, { ...OPEN, upload: { nullPartUrls: 'page' } });
    const paged = await createJob(m.api);
    assert.deepEqual([paged.json.upload.part_urls, paged.json.upload.next_part_number], [[], 1]);
    const page = (await m.api('GET', `/v1/uploads/${paged.json.job_id}/part-urls?start=1`)).json;
    assert.deepEqual([page.part_urls, page.next_part_number, page.total_parts], [null, null, 3]);
  });
});

test('r2: signature, expiry, Authorization, Content-Length and size checks', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, upload: { expireFirstPage: true } });
    const create = await createJob(m.api);
    const { upload } = create.json;
    const expired = await putPart(upload, upload.part_urls[0]);
    assert.equal(expired.res.status, 403);
    assert.match(await expired.res.text(), /<Code>AccessDenied<\/Code>/);
    const page = (await m.api('GET', `/v1/uploads/${create.json.job_id}/part-urls?start=1`)).json;
    const fresh = await putPart(page, page.part_urls[0]);
    assert.equal(fresh.res.status, 200);
    assert.match(fresh.res.headers.get('etag') ?? '', /^"[0-9a-f]{32}"$/);

    const tampered = page.part_urls[1].url.replace(/sig=(\d+)\.[0-9a-f]+/, 'sig=$1.deadbeef');
    assert.equal((await fetch(tampered, { method: 'PUT', body: partBytes(page, 2) })).status, 403);
    const withAuth = await fetch(page.part_urls[1].url, {
      method: 'PUT',
      body: partBytes(page, 2),
      headers: { authorization: 'Bearer x' },
    });
    assert.equal(withAuth.status, 400);
    assert.equal((await fetch(page.part_urls[1].url, { method: 'PUT', body: new Uint8Array(5) })).status, 400);
    assert.equal(
      (await fetch(page.part_urls[1].url.replace('/2?', '/9?'), { method: 'PUT', body: new Uint8Array(5) })).status,
      404,
    );

    const status = await new Promise((resolve, reject) => {
      const url = new URL(page.part_urls[1].url);
      const req = request(url, { method: 'PUT', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(partBytes(page, 2));
    });
    assert.equal(status, 411);
  });
});

test('r2: part URLs stay valid after a fractional clock advance', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    await m.api('POST', '/__clock', { json: { advance: 2.75 }, auth: false });
    const { upload } = (await createJob(m.api)).json;
    assert.match(upload.part_urls[0].url, /sig=\d+\./);
    assert.equal((await putPart(upload, upload.part_urls[0])).res.status, 200);
  });
});

test('complete: strict part check, etags, ordering, failure releases the hold', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    const create = await createJob(m.api);
    const { upload, job_id: id } = create.json;
    const etags = [];
    for (const part of upload.part_urls.slice(0, 2))
      etags.push({ n: part.n, etag: (await putPart(upload, part)).etag });
    assert.equal(
      (await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts: etags.reverse() } })).json.error,
      'bad_request',
    );
    const missing = await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts: etags.reverse() } });
    assert.deepEqual(missing.json, { error: 'upload_incomplete', code: 1041 });
    assert.equal(missing.status, 422);
    const state = (await m.api('GET', '/__state', { auth: false })).json;
    assert.equal(state.holds, 0);
    assert.equal(state.balanceSeconds, 36000);
    assert.equal((await m.api('GET', `/v1/jobs/${id}`)).json.state, 'failed');
    assert.equal((await m.api('POST', `/v1/uploads/${id}/heartbeat`)).json.error, 'wrong_state');
  });
});

test('complete: wrong etag, parts body in proxied mode, no parts, repeat is safe', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    const create = await createJob(m.api);
    const { upload, job_id: id } = create.json;
    assert.equal((await m.api('POST', `/v1/uploads/${id}/complete`)).json.error, 'no_parts');
    /** @type {{ n: number, etag: string }[]} */
    const parts = [];
    for (const part of upload.part_urls) parts.push({ n: part.n, etag: (await putPart(upload, part)).etag });
    const bad = parts.map((p) => ({ ...p }));
    bad[1] = { n: 2, etag: '0'.repeat(32) };
    assert.equal(
      (await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts: bad } })).json.error,
      'upload_incomplete',
    );

    const second = await createJob(m.api, { key: 'second-key-000000000' });
    const up2 = second.json.upload;
    for (const part of up2.part_urls) await putPart(up2, part);
    const body = { parts: up2.part_urls.map((/** @type {{ n: number }} */ p) => ({ n: p.n, etag: 'x' })) };
    assert.equal(
      (await m.api('POST', `/v1/uploads/${second.json.job_id}/complete`, { json: body })).json.error,
      'upload_incomplete',
    );

    const third = await createJob(m.api, { key: 'third-key-0000000000' });
    const up3 = third.json.upload;
    const etags = [];
    for (const part of up3.part_urls) etags.push({ n: part.n, etag: (await putPart(up3, part)).etag });
    const ok = await m.api('POST', `/v1/uploads/${third.json.job_id}/complete`, { json: { parts: etags } });
    assert.deepEqual(Object.keys(ok.json).sort(), [
      'balance_seconds',
      'held_seconds',
      'ok',
      'state',
      'verified_seconds',
    ]);
    assert.equal(ok.json.state, 'queued');
    assert.equal(ok.json.verified_seconds, 21);
    const again = await m.api('POST', `/v1/uploads/${third.json.job_id}/complete`, { json: { parts: etags } });
    assert.equal(again.status, 200);
    assert.equal((await m.api('POST', `/v1/uploads/${third.json.job_id}/heartbeat`)).json.error, 'wrong_state');
  });
});

test('proxied mode: upload is null, PUT parts need octet-stream, complete takes no body', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, upload: null });
    const create = await createJob(m.api);
    assert.equal(create.json.upload, null);
    const id = create.json.job_id;
    assert.equal((await m.api('GET', `/v1/uploads/${id}/part-urls`)).json, null);
    const url = `/v1/uploads/${id}/parts/1`;
    assert.equal((await m.api('PUT', url, { body: new Uint8Array(10) })).json.error, 'bad_request');
    assert.equal(
      (
        await m.api('PUT', `/v1/uploads/${id}/parts/0`, {
          body: new Uint8Array(10),
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).json.error,
      'bad_part_number',
    );
    const short = await m.api('PUT', url, {
      body: new Uint8Array(10),
      headers: { 'content-type': 'application/octet-stream' },
    });
    assert.deepEqual(short.json, { ok: true, part: 1 });
    assert.equal((await m.api('POST', `/v1/uploads/${id}/complete`)).json.error, 'upload_incomplete');

    const second = await createJob(m.api, { key: 'proxied-key-00000000' });
    const put = await m.api('PUT', `/v1/uploads/${second.json.job_id}/parts/1`, {
      body: new Uint8Array(FILE_SIZE),
      headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(put.status, 200);
    const done = await m.api('POST', `/v1/uploads/${second.json.job_id}/complete`);
    assert.equal(done.json.ok, true);
  });
});

test('heartbeat: ok while uploading, counted in the log with mock time', async () => {
  await withMock(async (m) => {
    await select(m, OPEN);
    const id = (await createJob(m.api)).json.job_id;
    await m.advance(120);
    assert.deepEqual((await m.api('POST', `/v1/uploads/${id}/heartbeat`)).json, { ok: true });
    const log = (await m.api('GET', '/__log', { auth: false })).json;
    assert.equal(log.at(-1).route, 'POST /v1/uploads/{job}/heartbeat');
    assert.equal(log.at(-1).t, 120);
    assert.equal((await m.api('POST', '/v1/uploads/job_missing/heartbeat')).status, 404);
  });
});

test('upload config: loseParts drops a part silently, completeState and verifiedSeconds apply', async () => {
  await withMock(async (m) => {
    await select(m, { ...OPEN, upload: { loseParts: [2] } });
    const { upload, job_id: id } = (await createJob(m.api)).json;
    const etags = [];
    for (const part of upload.part_urls) etags.push({ n: part.n, etag: (await putPart(upload, part)).etag });
    assert.equal(
      (await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts: etags } })).json.error,
      'upload_incomplete',
    );

    await select(m, { ...OPEN, completeState: 'done', upload: { verifiedSeconds: 25 } });
    const next = (await createJob(m.api)).json;
    const tags = [];
    for (const part of next.upload.part_urls) tags.push({ n: part.n, etag: (await putPart(next.upload, part)).etag });
    const done = await m.api('POST', `/v1/uploads/${next.job_id}/complete`, { json: { parts: tags } });
    assert.deepEqual([done.json.state, done.json.verified_seconds], ['done', 25]);
  });
});
