// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_EPOCH } from '../state.mjs';
import { errorReply, isRecord, parseJson, withFutureFields } from '../util.mjs';
import { findJob, isJob } from './uploads.mjs';

/** @typedef {import('../types.js').Ctx} Ctx */
/** @typedef {import('../types.js').Job} Job */
/** @typedef {import('../types.js').State} State */
/** @typedef {import('../types.js').Reply} Reply */
/** @typedef {import('../types.js').Phase} Phase */
/** @typedef {import('../types.js').RouteDef} RouteDef */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'transcripts');
/** @type {Phase[]} */
const DEFAULT_FLOW = [{ state: 'processing', polls: 1 }, { state: 'done' }];
const CURSOR_PREFIX = 'cur_';

/**
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function loadFixture(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`bad fixture name: ${name}`);
  const parsed = parseJson(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  if (!isRecord(parsed)) throw new Error(`fixture ${name} is not an object`);
  return parsed;
}

/**
 * @param {State} state
 * @param {Record<string, unknown>} base
 * @param {string} id
 * @param {string | null} title
 * @returns {Record<string, unknown>}
 */
function transcriptDetail(state, base, id, title) {
  /** @type {Record<string, unknown>} */
  const detail = { ...base, id };
  if (title !== null) detail['title'] = title;
  if (state.config.forwardCompat !== true) return detail;
  const body = isRecord(detail['body']) ? detail['body'] : {};
  const original = isRecord(body['original']) ? body['original'] : {};
  const utterances = Array.isArray(original['utterances']) ? original['utterances'] : [];
  return withFutureFields(true, {
    ...detail,
    body: withFutureFields(true, {
      ...body,
      original: {
        ...original,
        utterances: utterances.map((/** @type {unknown} */ u) => (isRecord(u) ? { ...u, confidence: 0.9 } : u)),
      },
    }),
  });
}

/**
 * @param {Job} job
 * @param {State} state
 * @returns {Phase}
 */
function currentPhase(job, state) {
  const flow = state.config.jobFlow ?? DEFAULT_FLOW;
  for (;;) {
    const phase = flow[Math.min(job.phaseIndex, flow.length - 1)];
    if (phase === undefined) return { state: 'done' };
    const last = job.phaseIndex >= flow.length - 1;
    const timeUp = phase.untilClock !== undefined && state.now >= phase.untilClock;
    const pollsUp = phase.polls !== undefined && job.phasePolls >= phase.polls;
    if (!last && (timeUp || pollsUp)) {
      job.phaseIndex += 1;
      job.phasePolls = 0;
      continue;
    }
    job.phasePolls += 1;
    return phase;
  }
}

/**
 * @param {State} state
 * @param {Job} job
 */
function advanceJob(state, job) {
  if (!job.completed || job.state === 'done' || job.state === 'failed') return;
  const phase = currentPhase(job, state);
  job.state = phase.state;
  if (phase.state === 'done') job.transcriptId = `tr_conf_${String(job.seq).padStart(4, '0')}`;
  if (phase.state === 'failed') {
    job.error = phase.error ?? 'processing failed';
    job.failureKind = phase.failure_kind ?? null;
  }
}

/**
 * @param {State} state
 * @param {Job} job
 */
function jobView(state, job) {
  return withFutureFields(state.config.forwardCompat, {
    id: job.id,
    state: job.state,
    mode: 'standard',
    declared_seconds: job.declaredSeconds,
    verified_seconds: job.verifiedSeconds,
    actual_seconds: job.state === 'done' ? job.declaredSeconds : null,
    billable_seconds: job.state === 'done' ? job.declaredSeconds : 0,
    error: job.error,
    failure_kind: job.failureKind,
    retry_of: null,
    created_at: job.createdAt,
    transcript_id: job.transcriptId,
    private_result_expires_at: null,
    private_result_available: false,
    options: job.options,
  });
}

/** @param {Ctx} ctx @returns {Reply} */
function getJob(ctx) {
  const job = findJob(ctx.state, ctx.params['id'] ?? '');
  if (!isJob(job)) return job;
  advanceJob(ctx.state, job);
  return { status: 200, json: jobView(ctx.state, job) };
}

/**
 * @param {string} secret
 * @param {number} offset
 * @returns {string}
 */
function mintCursor(secret, offset) {
  const mac = createHash('sha256').update(`cursor|${secret}|${offset}`).digest('hex').slice(0, 12);
  return `${CURSOR_PREFIX}${Buffer.from(String(offset)).toString('base64url')}.${mac}`;
}

/**
 * @param {string} secret
 * @param {string} cursor
 * @returns {number | null}
 */
function readCursor(secret, cursor) {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const [encoded = '', mac = ''] = cursor.slice(CURSOR_PREFIX.length).split('.');
  const offset = Number(Buffer.from(encoded, 'base64url').toString());
  if (!Number.isInteger(offset) || offset < 0) return null;
  return mintCursor(secret, offset) === cursor && mac !== '' ? offset : null;
}

/**
 * @param {Ctx} ctx
 * @returns {{ offset: number, limit: number } | Reply}
 */
function pageParams(ctx) {
  const rawLimit = ctx.query['limit'];
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return errorReply('bad_request');
  const cursor = ctx.query['cursor'];
  const offset = cursor === undefined ? 0 : readCursor(ctx.state.origin, cursor);
  if (offset === null) return errorReply('bad_request');
  return { offset, limit: Math.min(limit, 100) };
}

/**
 * @param {number} index 1-based
 * @returns {string}
 */
function listedId(index) {
  return `tr_list_${String(index).padStart(3, '0')}`;
}

/** @param {Ctx} ctx @returns {Reply} */
function listTranscripts(ctx) {
  const page = pageParams(ctx);
  if ('status' in page) return page;
  const count = ctx.state.config.listing?.count ?? 0;
  const rows = [];
  for (let i = page.offset + 1; i <= Math.min(count, page.offset + page.limit); i++) {
    rows.push({
      id: listedId(i),
      title: `Synthetic ${String(i).padStart(3, '0')}`,
      language_detected: 'en',
      duration_seconds: 60,
      created_at: BASE_EPOCH - i * 60,
      auto_delete_at: null,
      tags: [],
      options: {
        language_code: null,
        speaker_detection: true,
        medical_mode: false,
        multichannel: false,
        translation_targets: [],
        keyterms: false,
        prompt: false,
        auto_generate_insights: null,
      },
      insights_state: 'none',
    });
  }
  const end = page.offset + page.limit;
  return {
    status: 200,
    json: { transcripts: rows, next_cursor: end < count ? mintCursor(ctx.state.origin, end) : null },
  };
}

/** @param {Ctx} ctx @returns {Reply} */
function getTranscript(ctx) {
  const { state } = ctx;
  const id = ctx.params['id'] ?? '';
  const base = loadFixture(state.config.fixture ?? 'one-speaker');
  const listed = /^tr_list_(\d{3})$/.exec(id);
  if (listed !== null && Number(listed[1]) >= 1 && Number(listed[1]) <= (state.config.listing?.count ?? 0)) {
    return { status: 200, json: transcriptDetail(state, base, id, `Synthetic ${listed[1] ?? ''}`) };
  }
  const job = [...state.jobs.values()].find((candidate) => candidate.transcriptId === id);
  if (job === undefined) return errorReply('not_found');
  return { status: 200, json: transcriptDetail(state, base, id, null) };
}

/** @param {Ctx} ctx @returns {Reply} */
function listJobs(ctx) {
  const page = pageParams(ctx);
  if ('status' in page) return page;
  let jobs = [...ctx.state.jobs.values()];
  if (ctx.query['active'] === 'true') jobs = jobs.filter((job) => !['done', 'failed'].includes(job.state));
  const slice = jobs.slice(page.offset, page.offset + page.limit);
  const end = page.offset + page.limit;
  return {
    status: 200,
    json: {
      jobs: slice.map((job) => jobView(ctx.state, job)),
      next_cursor: end < jobs.length ? mintCursor(ctx.state.origin, end) : null,
    },
  };
}

/** @type {RouteDef[]} */
export const jobRoutes = [
  { method: 'GET', pattern: '/v1/jobs', key: 'jobs', auth: true, handler: listJobs },
  { method: 'GET', pattern: '/v1/jobs/{id}', key: 'job', auth: true, handler: getJob },
  { method: 'GET', pattern: '/v1/transcripts', key: 'transcripts', auth: true, handler: listTranscripts },
  {
    method: 'GET',
    pattern: '/v1/transcripts/deleted',
    key: 'deleted',
    auth: true,
    handler: () => ({ status: 200, json: { deleted: [], next_cursor: null } }),
  },
  { method: 'GET', pattern: '/v1/transcripts/{id}', key: 'transcript', auth: true, handler: getTranscript },
];
