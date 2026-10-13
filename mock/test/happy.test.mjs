// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { withMock } from './helpers.mjs';

const FILE = readFileSync(new URL('../../fixtures/media/cbr-20s.mp3', import.meta.url));
const SIZE = FILE.length;

test('happy-direct: create, PUT parts to /__r2, complete, job, transcript', async () => {
  await withMock(async ({ api, scenario, port }) => {
    assert.equal((await scenario('happy-direct')).status, 200);

    const account = await api('GET', '/v1/account');
    assert.equal(account.json.balance_seconds, 36000);

    const create = await api('POST', '/v1/uploads', {
      json: {
        size_bytes: SIZE,
        duration_seconds: 21,
        title: 'happy',
        idempotency_key: '3f0c9a1e-7b1e-4c55-9d3a-0a1b2c3d4e5f',
      },
    });
    assert.equal(create.status, 200);
    const { job_id: jobId, upload } = create.json;
    assert.equal(upload.total_parts, 3);
    assert.equal(upload.part_urls.length, 3);
    assert.equal(upload.next_part_number, null);
    assert.ok(upload.part_urls[0].url.startsWith(`http://127.0.0.1:${port}/__r2/${jobId}/1?sig=`));

    /** @type {{ n: number, etag: string }[]} */
    const parts = [];
    for (const { n, url } of upload.part_urls) {
      const body = FILE.subarray((n - 1) * upload.part_size_bytes, n * upload.part_size_bytes);
      const put = await fetch(url, { method: 'PUT', body: body });
      assert.equal(put.status, 200);
      const etag = put.headers.get('etag');
      assert.ok(etag?.startsWith('"'));
      const expected = createHash('md5').update(body).digest('hex');
      assert.equal(etag, `"${expected}"`);
      parts.push({ n, etag: expected });
    }

    const complete = await api('POST', `/v1/uploads/${jobId}/complete`, { json: { parts } });
    assert.equal(complete.status, 200);
    assert.equal(complete.json.ok, true);

    let job = await api('GET', `/v1/jobs/${jobId}`);
    for (let i = 0; i < 5 && job.json.state !== 'done'; i++) job = await api('GET', `/v1/jobs/${jobId}`);
    assert.equal(job.json.state, 'done');
    const transcript = await api('GET', `/v1/transcripts/${job.json.transcript_id}`);
    assert.equal(transcript.status, 200);
    assert.equal(transcript.json.body.original.utterances.length, 6);

    const log = (await api('GET', '/__log', { auth: false })).json;
    const routes = log.map((/** @type {{ route: string }} */ e) => e.route);
    assert.equal(routes.filter((/** @type {string} */ r) => r === 'POST /v1/uploads').length, 1);
    assert.equal(routes.filter((/** @type {string} */ r) => r === 'PUT /__r2/{job}/{n}').length, 3);
    const r2 = log.filter((/** @type {{ route: string }} */ e) => e.route === 'PUT /__r2/{job}/{n}');
    assert.ok(
      r2.every((/** @type {{ headers: Record<string, string> }} */ e) => e.headers['authorization'] === 'absent'),
    );
    assert.equal(log[0].headers['authorization'], 'present');
    assert.match(log[0].bodySha256, /^[0-9a-f]{64}$/);

    const verify = await api('GET', '/__verify', { auth: false });
    assert.deepEqual(verify.json, { ok: true, failures: [] });
  });
});
