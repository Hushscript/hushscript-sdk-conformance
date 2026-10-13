// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createJob, withMock } from './helpers.mjs';

test('control: health, unknown scenario, bad mock key, reset', async () => {
  await withMock(async ({ api, scenario }) => {
    assert.deepEqual((await api('GET', '/__health', { auth: false })).json, { ok: true });
    assert.equal((await scenario('no-such-scenario')).status, 404);
    assert.equal((await scenario('../etc/passwd')).status, 404);
    const typo = await api('POST', '/__scenario', { json: { mock: { crate: [] } }, auth: false });
    assert.equal(typo.status, 400);
    await scenario('happy-direct');
    await createJob(api);
    assert.equal((await api('GET', '/__log', { auth: false })).json.length, 1);
    await api('POST', '/__reset', { auth: false });
    assert.deepEqual((await api('GET', '/__log', { auth: false })).json, []);
    assert.equal((await api('GET', '/__state', { auth: false })).json.scenario, null);
  });
});

test('control: the log reduces Authorization and is not written for control calls', async () => {
  await withMock(async ({ api }) => {
    await api('GET', '/v1/account');
    await api('GET', '/v1/account', { auth: false });
    const log = (await api('GET', '/__log', { auth: false })).json;
    assert.equal(log.length, 2);
    assert.deepEqual(
      log.map((/** @type {{ headers: Record<string, string> }} */ e) => e.headers['authorization']),
      ['present', 'absent'],
    );
    assert.equal(JSON.stringify(log).includes('hsr1'), false);
    assert.deepEqual(Object.keys(log[0]).sort(), [
      'bodySha256',
      'headers',
      'idempotencyKey',
      'method',
      'path',
      'query',
      'route',
      'status',
      't',
    ]);
  });
});

test('control: scenarios and fixtures are served, traversal is refused', async () => {
  await withMock(async ({ api }) => {
    const list = (await api('GET', '/__scenarios', { auth: false })).json.scenarios;
    assert.ok(list.includes('happy-direct'));
    const file = await api('GET', '/__files/scenarios/happy-direct.json', { auth: false });
    assert.equal(file.json.name, 'happy-direct');
    const hints = await api('GET', '/__files/hints.json', { auth: false });
    assert.equal(hints.status, 200);
    assert.equal((await api('GET', '/__files/fixtures/media/durations.json', { auth: false })).status, 200);
    assert.equal((await api('GET', '/__files/mock/server.mjs', { auth: false })).status, 404);
    assert.equal((await api('GET', '/__files/fixtures/../mock/server.mjs', { auth: false })).status, 404);
    assert.equal((await api('GET', '/__files/%2e%2e/package.json', { auth: false })).status, 404);
  });
});

test('clock: moves only through POST /__clock and rejects bad input', async () => {
  await withMock(async ({ api, advance }) => {
    assert.equal((await api('GET', '/__clock', { auth: false })).json.now, 0);
    await api('GET', '/v1/account');
    assert.equal((await api('GET', '/__clock', { auth: false })).json.now, 0);
    assert.equal((await advance(30)).json.now, 30);
    assert.equal((await advance(0.5)).json.now, 30.5);
    assert.equal((await advance(-1)).status, 400);
    assert.equal((await api('POST', '/__clock', { json: { advance: 'x' }, auth: false })).status, 400);
    const log = (await api('GET', '/__log', { auth: false })).json;
    assert.equal(log[0].t, 0);
  });
});

test('clock: a held response is released once the clock reaches it', async () => {
  await withMock(async ({ api, advance, base }) => {
    await api('POST', '/__scenario', {
      json: { mock: { create: [{ holdSeconds: 100 }], account: { balance_seconds: 1000 } } },
      auth: false,
    });
    let done = false;
    const pending = createJob(api).then((reply) => {
      done = true;
      return reply;
    });
    await new Promise((r) => setTimeout(r, 100));
    const held = (await api('GET', '/__state', { auth: false })).json;
    assert.equal(held.pendingHolds, 1);
    assert.equal(held.nextHoldAt, 100);
    await advance(99);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(done, false);
    assert.equal((await api('GET', '/__state', { auth: false })).json.pendingHolds, 1);
    await advance(1);
    assert.equal((await pending).status, 200);
    const idle = (await api('GET', '/__state', { auth: false })).json;
    assert.equal(idle.pendingHolds, 0);
    assert.equal(idle.nextHoldAt, null);
    assert.ok(base.startsWith('http://127.0.0.1:'));
  });
});

test('cli: --port 0 prints READY with the bound port', async () => {
  const child = spawn(process.execPath, ['mock/server.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [chunk] = /** @type {[Buffer]} */ (await once(child.stdout, 'data'));
    const match = /^READY (\d+)\n$/.exec(chunk.toString());
    assert.ok(match);
    const res = await fetch(`http://127.0.0.1:${match[1]}/__health`);
    assert.equal(res.status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('control: the log records the response status; a dropped request has none', async () => {
  await withMock(async ({ api }) => {
    await api('POST', '/__scenario', {
      json: { mock: { balance: [{ status: 503 }], rotate: [{ drop: 'after-read' }] } },
      auth: false,
    });
    await api('GET', '/v1/account');
    await api('GET', '/v1/account');
    await assert.rejects(api('POST', '/v1/agent/credentials/rotate'));
    const log = (await api('GET', '/__log', { auth: false })).json;
    assert.deepEqual(
      log.map((/** @type {{ status: number | null }} */ e) => e.status),
      [503, 200, null],
    );
  });
});
