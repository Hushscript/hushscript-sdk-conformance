// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, partBytes, withMock } from './helpers.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('flow heartbeat-cadence: a driver stepping the mock clock satisfies the scenario', async () => {
  await withMock(async (m) => {
    await m.scenario('heartbeat-cadence');
    const create = (await createJob(m.api)).json;
    const { upload, job_id: id } = create;
    /** @type {{ n: number, etag: string }[]} */
    const parts = [];
    let finished = false;
    const uploading = (async () => {
      for (let i = 0; i < upload.part_urls.length; i += 4) {
        await Promise.all(
          upload.part_urls.slice(i, i + 4).map(async (/** @type {{ n: number, url: string }} */ part) => {
            const res = await fetch(part.url, { method: 'PUT', body: partBytes(upload, part.n) });
            parts.push({ n: part.n, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') });
          }),
        );
      }
      parts.sort((a, b) => a.n - b.n);
      assert.equal((await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts } })).status, 200);
      finished = true;
    })();
    let virtual = 0;
    while (!finished) {
      await sleep(15);
      await m.advance(30);
      virtual += 30;
      if (virtual % 120 === 0) await m.api('POST', `/v1/uploads/${id}/heartbeat`);
    }
    await uploading;
    assert.ok(virtual >= 600, `virtual time ${virtual}`);
    assert.deepEqual(
      (await m.api('GET', '/__verify', { auth: false })).json.failures.filter((/** @type {string} */ f) =>
        f.startsWith('heartbeat'),
      ),
      [],
    );
  });
});

test('flow direct-fails-after-success: ten direct PUTs in total and no proxied PUT', async () => {
  await withMock(async (m) => {
    await m.scenario('direct-fails-after-success');
    const { upload, job_id: id } = (await createJob(m.api)).json;
    /** @type {{ n: number, etag: string }[]} */
    const parts = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const part = upload.part_urls[next++];
        if (part === undefined) return;
        for (let attempt = 0; attempt < 4; attempt++) {
          const res = await fetch(part.url, { method: 'PUT', body: partBytes(upload, part.n) });
          if (res.status === 200) {
            parts.push({ n: part.n, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') });
            break;
          }
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    parts.sort((a, b) => a.n - b.n);
    assert.equal(parts.length, 8);
    assert.equal((await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts } })).status, 200);
    const verify = (await m.api('GET', '/__verify', { auth: false })).json;
    assert.deepEqual(
      verify.failures.filter((/** @type {string} */ f) => f.includes('__r2') || f.includes('parts/')),
      [],
    );
  });
});

test('flow wait-timeout-then-resume: the job finishes once the clock passes 200', async () => {
  await withMock(async (m) => {
    await m.scenario('wait-timeout-then-resume');
    const { upload, job_id: id } = (await createJob(m.api)).json;
    /** @type {{ n: number, etag: string }[]} */
    const parts = [];
    for (const part of upload.part_urls) {
      const res = await fetch(part.url, { method: 'PUT', body: partBytes(upload, part.n) });
      parts.push({ n: part.n, etag: (res.headers.get('etag') ?? '').replaceAll('"', '') });
    }
    await m.api('POST', `/v1/uploads/${id}/complete`, { json: { parts } });
    await m.advance(60);
    assert.equal((await m.api('GET', `/v1/jobs/${id}`)).json.state, 'processing');
    const replay = await createJob(m.api);
    assert.equal(replay.json.upload, null);
    assert.equal(replay.json.job_id, id);
    await m.advance(150);
    const job = (await m.api('GET', `/v1/jobs/${id}`)).json;
    assert.equal(job.state, 'done');
    assert.equal((await m.api('GET', `/v1/transcripts/${job.transcript_id}`)).json.body.original.utterances.length, 6);
    assert.deepEqual((await m.api('GET', '/__state', { auth: false })).json.jobs, 1);
  });
});
