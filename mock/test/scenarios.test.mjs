// @ts-check
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { STEP_KEYS, loadMock } from '../state.mjs';

const ROOT = new URL('../../', import.meta.url);

const REQUIRED = [
  'happy-direct',
  'happy-proxied',
  'direct-fails-first-part',
  'direct-fails-after-success',
  'r2-403-expired-url',
  'part-urls-paging',
  'create-429-no-retry-after',
  'create-network-drop-after-commit',
  'too-many-active-jobs',
  'heartbeat-cadence',
  'complete-returns-done',
  'complete-upload-incomplete',
  'job-failed',
  'wait-timeout-then-resume',
  'resume-different-file',
  'insufficient-balance-preflight',
  'insufficient-balance-server',
  'unsupported-media',
  'too-short',
  'buy-happy',
  'buy-no-card',
  'buy-502-then-ok',
  'buy-4021',
  'scope-missing',
  'retry-after-61',
  'claim-lost-response',
  'rotate-lost-response',
  'list-pagination',
  'redaction',
  'forward-compat',
  'probe-durations',
  'format-goldens',
];
const OPS = [
  'transcribe',
  'resume',
  'balance',
  'listTranscripts',
  'getTranscript',
  'buy',
  'claim',
  'rotate',
  'probe',
  'format',
];
const EXPECT_KEYS = [
  'result',
  'error',
  'requests',
  'requestsAtLeast',
  'requestsAtMost',
  'noRequests',
  'sameIdempotencyKey',
  'authorization',
  'queries',
  'state',
  'heartbeat',
  'minGapSeconds',
];

/** @param {string} name @returns {any} */
function scenario(name) {
  return JSON.parse(readFileSync(new URL(`scenarios/${name}.json`, ROOT), 'utf8'));
}

test('scenarios: exactly the rows of the spec table exist', () => {
  const files = readdirSync(new URL('scenarios/', ROOT))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  assert.deepEqual([...files].sort(), [...REQUIRED].sort());
});

for (const name of REQUIRED) {
  test(`scenario ${name}: well formed`, () => {
    const s = scenario(name);
    assert.equal(s.name, name);
    assert.ok(OPS.includes(s.call.op), `unknown op ${s.call.op}`);
    if (s.call.prior !== undefined) assert.ok(OPS.includes(s.call.prior.op));
    assert.doesNotThrow(() => loadMock(s.mock));
    for (const key of Object.keys(s.expect)) assert.ok(EXPECT_KEYS.includes(key), `unknown expect key ${key}`);
    assert.ok(s.expect.result !== undefined || s.expect.error !== undefined || s.expect.requests !== undefined);
    const files = [s.call.args?.file, s.call.prior?.args?.file].filter((f) => typeof f === 'string');
    for (const file of files) assert.doesNotThrow(() => readFileSync(new URL(`fixtures/${file}`, ROOT)));
  });
}

test('scenarios: fixture-derived counts match the repository', () => {
  const durations = JSON.parse(readFileSync(new URL('fixtures/media/durations.json', ROOT), 'utf8'));
  const probe = scenario('probe-durations');
  /** @type {string[]} */
  const refuse = probe.call.args.refuse;
  assert.ok(
    refuse.every((file) => file in durations),
    'every refused file is a durations.json key',
  );
  assert.equal(probe.expect.result.refused, refuse.length);
  assert.equal(probe.expect.result.checked, Object.keys(durations).length - refuse.length);
  const goldens = readdirSync(new URL('fixtures/exports/', ROOT)).length;
  assert.equal(scenario('format-goldens').expect.result.checked, goldens);
  const fixture = JSON.parse(readFileSync(new URL('fixtures/transcripts/one-speaker.json', ROOT), 'utf8'));
  assert.equal(scenario('happy-direct').expect.result.utteranceCount, fixture.body.original.utterances.length);
});

test('scenarios: error codes named in scenarios exist in the catalog', async () => {
  const { ERROR_CATALOG } = await import('../errors.mjs');
  for (const name of REQUIRED) {
    const s = scenario(name);
    for (const key of STEP_KEYS) {
      const rules = s.mock[key] ?? [];
      for (const rule of rules)
        if (rule.error !== undefined) assert.ok(ERROR_CATALOG[rule.error], `${name}: ${rule.error}`);
    }
  }
});

test('scenarios: every SDK-side error slug has a hint', async () => {
  const { ERROR_CATALOG } = await import('../errors.mjs');
  const hints = JSON.parse(readFileSync(new URL('hints.json', ROOT), 'utf8'));
  const slugs = new Set();
  for (const name of REQUIRED) {
    const s = scenario(name);
    for (const call of [s.call, s.call.prior]) {
      const error = call?.expectError ?? (call === s.call ? s.expect.error : undefined);
      if (typeof error?.code === 'string' && !ERROR_CATALOG[error.code]) slugs.add(error.code);
    }
  }
  assert.ok(slugs.has('resume_file_mismatch'));
  for (const slug of slugs) assert.ok(hints[slug] !== undefined, `hints.json has no ${slug}`);
});

test('scenarios: the spec hint texts for the resume errors are exact', () => {
  const hints = JSON.parse(readFileSync(new URL('hints.json', ROOT), 'utf8'));
  assert.equal(
    hints.resume_file_mismatch,
    'This is not the file the upload started with. Pass the original file, or start a new transcription.',
  );
  assert.equal(hints.resume_file_required, 'The upload was not finished. Pass the original file to resume it.');
});

test('scenarios: unknown rule keys in any scenario fail the load', () => {
  assert.throws(() => loadMock({ r2: [{ afterDirectSuccess: true, status: 503 }] }), /unknown rule key/);
});
