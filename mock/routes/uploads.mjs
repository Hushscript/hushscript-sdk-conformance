// @ts-check
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { BASE_EPOCH, activeJobs, limitsView } from '../state.mjs';
import { errorReply, field, isInt, isRecord, withFutureFields } from '../util.mjs';

/** @typedef {import('../types.js').Ctx} Ctx */
/** @typedef {import('../types.js').Job} Job */
/** @typedef {import('../types.js').State} State */
/** @typedef {import('../types.js').Reply} Reply */
/** @typedef {import('../types.js').RouteDef} RouteDef */

const PAGE_SIZE = 16;
const MAX_PART_BYTES = 32 * 1024 * 1024;
const URL_LIFETIME_SECONDS = 86_400;

/** @param {State} state */
function fixturePath(state) {
  return new URL(`../../fixtures/${state.config.expectedUploadFile ?? ''}`, import.meta.url);
}

/**
 * Hash the original fixture range, independently of the SDK's body and completion ETag.
 * @param {Ctx} ctx
 * @param {Job} job
 * @param {number} n
 */
async function matchesFixture(ctx, job, n) {
  if (ctx.state.config.expectedUploadFile === undefined) return true;
  const partSize = job.partSize ?? MAX_PART_BYTES;
  const start = (n - 1) * partSize;
  const length = Math.min(partSize, job.size - start);
  if (length <= 0 || ctx.bodyLength !== length) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(fixturePath(ctx.state), { start, end: start + length - 1 })) {
    if (!(chunk instanceof Uint8Array)) return false;
    hash.update(chunk);
  }
  return hash.digest('hex') === ctx.bodySha256;
}

/**
 * @param {string} jobId
 * @param {number} n
 * @param {number} exp
 * @returns {string}
 */
function signature(jobId, n, exp) {
  return createHash('sha256').update(`conformance-r2|${jobId}|${n}|${exp}`).digest('hex').slice(0, 24);
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Reply}
 */
function r2Error(status, code, message) {
  const text = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return { status, text, contentType: 'application/xml' };
}

/**
 * @param {State} state
 * @param {Job} job
 * @param {number} start
 * @param {boolean} expired
 */
function uploadPage(state, job, start, expired) {
  const total = job.totalParts ?? 0;
  const now = Math.floor(state.now);
  const exp = expired ? now - 1 : now + URL_LIFETIME_SECONDS;
  const urls = [];
  for (let n = start; n < start + PAGE_SIZE && n <= total; n++) {
    urls.push({ n, url: `${state.origin}/__r2/${job.id}/${n}?sig=${exp}.${signature(job.id, n, exp)}` });
  }
  const next = start + PAGE_SIZE <= total ? start + PAGE_SIZE : null;
  return { part_size_bytes: job.partSize, total_parts: total, part_urls: urls, next_part_number: next };
}

/**
 * @param {State} state
 * @param {Job} job
 * @returns {Reply}
 */
function createReply(state, job) {
  const direct = state.config.upload !== null && job.state === 'uploading';
  let upload = null;
  if (direct) {
    const expired = state.config.upload?.expireFirstPage === true && !job.firstPageServed;
    job.firstPageServed = true;
    upload = uploadPage(state, job, 1, expired);
    const nullPartUrls = state.config.upload?.nullPartUrls;
    if (nullPartUrls === 'create') upload = { ...upload, part_urls: null, next_part_number: null };
    if (nullPartUrls === 'page' || nullPartUrls === 'page404') {
      upload = { ...upload, part_urls: [], next_part_number: 1 };
    }
  }
  return {
    status: 200,
    json: withFutureFields(state.config.forwardCompat, {
      job_id: job.id,
      balance_seconds: state.balanceSeconds,
      held_seconds: state.heldSeconds,
      limits: limitsView(state),
      upload,
      funding: 'personal',
      state: job.state,
    }),
  };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function optionsSummary(raw) {
  const o = isRecord(raw) ? raw : {};
  const targets = Array.isArray(o['translation_targets']) ? o['translation_targets'] : [];
  const keyterms = Array.isArray(o['keyterms_prompt']) && o['keyterms_prompt'].length > 0;
  return {
    language_code: typeof o['language_code'] === 'string' ? o['language_code'] : null,
    speaker_detection: targets.length > 0 ? true : o['speaker_detection'] !== false,
    medical_mode: o['medical_mode'] === true,
    multichannel: o['multichannel'] === true,
    translation_targets: targets,
    keyterms,
    prompt: typeof o['prompt'] === 'string' && o['prompt'].length > 0,
    auto_generate_insights: typeof o['auto_generate_insights'] === 'boolean' ? o['auto_generate_insights'] : null,
  };
}

/**
 * Splits `parts` pieces out of `size` bytes: every part but the last has the returned size.
 * @param {number} size
 * @param {number} parts
 * @returns {number}
 */
function partSizeFor(size, parts) {
  let candidate = Math.ceil(size / parts);
  while (candidate > 1 && Math.ceil(size / candidate) < parts) candidate -= 1;
  return candidate;
}

/**
 * @param {State} state
 * @param {Job} job
 */
function releaseHold(state, job) {
  if (!job.holdActive) return;
  job.holdActive = false;
  state.heldSeconds -= job.declaredSeconds;
}

/**
 * @param {State} state
 * @param {string} id
 * @returns {Job | Reply}
 */
export function findJob(state, id) {
  return state.jobs.get(id) ?? errorReply('not_found');
}

/**
 * @param {Job | Reply} value
 * @returns {value is Job}
 */
export function isJob(value) {
  return 'parts' in value;
}

/** @param {Ctx} ctx @returns {Reply} */
function createUpload(ctx) {
  const { state } = ctx;
  const body = ctx.json;
  if (!isRecord(body)) return errorReply('bad_request');
  const size = body['size_bytes'];
  const duration = body['duration_seconds'];
  if (!isInt(size) || size < 1 || size > 5_000_000_000) return errorReply('size_out_of_range');
  if (!isInt(duration) || duration < 15 || duration > 36_000) return errorReply('duration_out_of_range');
  const key = body['idempotency_key'];
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 128 || /[^\x21-\x7e]/.test(key)) {
      return errorReply('invalid_idempotency_key');
    }
    const existing = state.keyIndex.get(key);
    const replay = existing === undefined ? undefined : state.jobs.get(existing);
    if (replay !== undefined) return createReply(state, replay);
  }
  if (state.config.expectedUploadFile !== undefined && size !== statSync(fixturePath(state)).size) {
    return errorReply('size_out_of_range');
  }
  const maxActive = state.config.account?.max_active_jobs ?? 50;
  if (activeJobs(state).length + (state.config.account?.active_jobs ?? 0) >= maxActive) {
    return errorReply('too_many_active_jobs');
  }
  if (state.balanceSeconds < duration) {
    return errorReply('insufficient_balance', {
      needed_seconds: duration,
      balance_seconds: state.balanceSeconds,
      held_seconds: state.heldSeconds,
    });
  }
  state.jobSeq += 1;
  const upload = state.config.upload;
  const parts = upload === undefined || upload === null ? 3 : (upload.parts ?? 3);
  const partSize = upload === null ? null : partSizeFor(size, parts);
  /** @type {Job} */
  const job = {
    id: `job_conf_${String(state.jobSeq).padStart(4, '0')}`,
    seq: state.jobSeq,
    state: 'uploading',
    key: typeof key === 'string' ? key : null,
    size,
    declaredSeconds: duration,
    title: typeof body['title'] === 'string' ? body['title'] : null,
    options: optionsSummary(body['transcription_options']),
    createdAt: BASE_EPOCH + state.now,
    partSize,
    totalParts: partSize === null ? null : Math.ceil(size / partSize),
    parts: new Map(),
    heartbeats: 0,
    completed: false,
    holdActive: true,
    verifiedSeconds: null,
    error: null,
    failureKind: null,
    transcriptId: null,
    phaseIndex: 0,
    phasePolls: 0,
    firstPageServed: false,
  };
  state.balanceSeconds -= duration;
  state.heldSeconds += duration;
  state.jobs.set(job.id, job);
  if (job.key !== null) state.keyIndex.set(job.key, job.id);
  return createReply(state, job);
}

/** @param {Ctx} ctx @returns {Reply} */
function partUrls(ctx) {
  const job = findJob(ctx.state, ctx.params['job'] ?? '');
  if (!isJob(job)) return job;
  if (ctx.state.config.upload === null) return { status: 200, json: null };
  if (job.state !== 'uploading') return errorReply('wrong_state');
  const raw = ctx.query['start'];
  const start = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(start) || start < 1 || start > (job.totalParts ?? 0)) return errorReply('bad_part_number');
  const page = uploadPage(ctx.state, job, start, false);
  if (ctx.state.config.upload?.nullPartUrls === 'page') {
    return { status: 200, json: { ...page, part_urls: null, next_part_number: null } };
  }
  if (ctx.state.config.upload?.nullPartUrls === 'page404') return errorReply('not_found');
  return { status: 200, json: page };
}

/** @param {Ctx} ctx @returns {Promise<Reply>} */
async function proxiedPart(ctx) {
  const job = findJob(ctx.state, ctx.params['job'] ?? '');
  if (!isJob(job)) return job;
  const n = Number(ctx.params['n']);
  if (!Number.isInteger(n) || n < 1) return errorReply('bad_part_number');
  if (job.state !== 'uploading') return errorReply('wrong_state');
  const type = ctx.headers['content-type'] ?? '';
  if (!type.startsWith('application/octet-stream')) return errorReply('bad_request');
  if (ctx.bodyLength > MAX_PART_BYTES) return errorReply('part_too_large');
  if (!(await matchesFixture(ctx, job, n))) return errorReply('bad_request');
  job.parts.set(n, { n, size: ctx.bodyLength, md5: ctx.bodyMd5, via: 'proxied' });
  return { status: 200, json: { ok: true, part: n } };
}

/** @param {Ctx} ctx @returns {Promise<Reply>} */
async function r2Put(ctx) {
  const { state } = ctx;
  const jobId = ctx.params['job'] ?? '';
  const n = Number(ctx.params['n']);
  const job = state.jobs.get(jobId);
  const total = job?.totalParts ?? null;
  if (job === undefined || total === null || !Number.isInteger(n) || n < 1 || n > total) {
    return r2Error(404, 'NoSuchKey', 'The specified key does not exist.');
  }
  if (ctx.headers.authorization !== undefined) {
    return r2Error(
      400,
      'InvalidArgument',
      'Only one auth mechanism allowed; only the X-Amz-Algorithm query parameter, Signature query string parameter or the Authorization header should be specified',
    );
  }
  const [expText = '', hash = ''] = (ctx.query['sig'] ?? '').split('.');
  const exp = Number(expText);
  if (!Number.isInteger(exp) || hash !== signature(jobId, n, exp)) {
    return r2Error(
      403,
      'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided.',
    );
  }
  if (exp < state.now) return r2Error(403, 'AccessDenied', 'Request has expired');
  if (ctx.headers['content-length'] === undefined)
    return r2Error(411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
  const partSize = job.partSize ?? 0;
  const expected = n < total ? partSize : job.size - partSize * (total - 1);
  if (ctx.bodyLength !== expected) {
    return r2Error(
      400,
      'IncompleteBody',
      `The request body is ${ctx.bodyLength} bytes; this part must be ${expected}.`,
    );
  }
  if (!(await matchesFixture(ctx, job, n))) {
    return r2Error(400, 'BadDigest', 'The part does not match the original fixture byte range.');
  }
  state.directSuccesses += 1;
  if (!(state.config.upload?.loseParts ?? []).includes(n)) {
    job.parts.set(n, { n, size: ctx.bodyLength, md5: ctx.bodyMd5, via: 'direct' });
  }
  return { status: 200, text: '', headers: { ETag: `"${ctx.bodyMd5}"` } };
}

/** @param {Ctx} ctx @returns {Reply} */
function heartbeat(ctx) {
  const job = findJob(ctx.state, ctx.params['job'] ?? '');
  if (!isJob(job)) return job;
  if (job.state !== 'uploading') return errorReply('wrong_state');
  job.heartbeats += 1;
  return { status: 200, json: { ok: true } };
}

/**
 * @param {Job} job
 * @param {unknown} body
 * @returns {boolean}
 */
function partsAreComplete(job, body) {
  const listed = field(body, 'parts');
  const direct = [...job.parts.values()].filter((part) => part.via === 'direct');
  const hasListed = Array.isArray(listed) && listed.length > 0;
  if (hasListed) {
    const seen = new Set();
    for (const item of listed) {
      const n = field(item, 'n');
      const etag = field(item, 'etag');
      if (!isInt(n) || typeof etag !== 'string') return false;
      const recorded = job.parts.get(n);
      if (recorded?.via !== 'direct' || recorded.md5 !== etag) return false;
      seen.add(n);
    }
    if (seen.size !== direct.length) return false;
  } else if (direct.length > 0) {
    return false;
  }
  const numbers = [...job.parts.keys()].sort((a, b) => a - b);
  if (numbers.length === 0) return false;
  if (numbers.some((n, index) => n !== index + 1)) return false;
  if (job.totalParts !== null && numbers.length !== job.totalParts) return false;
  const received = [...job.parts.values()].reduce((sum, part) => sum + part.size, 0);
  return received === job.size;
}

/**
 * @param {State} state
 * @param {Job} job
 * @returns {Reply}
 */
function completeReply(state, job) {
  return {
    status: 200,
    json: withFutureFields(state.config.forwardCompat, {
      ok: true,
      state: job.state,
      verified_seconds: job.verifiedSeconds,
      balance_seconds: state.balanceSeconds,
      held_seconds: state.heldSeconds,
    }),
  };
}

/** @param {Ctx} ctx @returns {Reply} */
function complete(ctx) {
  const { state } = ctx;
  const job = findJob(state, ctx.params['job'] ?? '');
  if (!isJob(job)) return job;
  if (job.completed) return completeReply(state, job);
  if (job.state === 'failed') return errorReply('upload_incomplete');
  const listed = field(ctx.json, 'parts');
  if (Array.isArray(listed) && listed.length > 1) {
    const order = listed.map((item) => field(item, 'n'));
    if (order.some((n, index) => index > 0 && Number(n) <= Number(order[index - 1]))) return errorReply('bad_request');
  }
  if (job.parts.size === 0) return errorReply('no_parts');
  if (!partsAreComplete(job, ctx.json)) {
    job.state = 'failed';
    job.error = 'upload incomplete';
    releaseHold(state, job);
    state.balanceSeconds += job.declaredSeconds;
    return errorReply('upload_incomplete');
  }
  const next = state.config.completeState ?? 'queued';
  job.completed = true;
  job.state = next;
  job.verifiedSeconds = state.config.upload?.verifiedSeconds ?? job.declaredSeconds;
  releaseHold(state, job);
  if (next === 'failed') state.balanceSeconds += job.declaredSeconds;
  if (next === 'done') job.transcriptId = `tr_conf_${String(job.seq).padStart(4, '0')}`;
  return completeReply(state, job);
}

/** @type {RouteDef[]} */
export const uploadRoutes = [
  { method: 'POST', pattern: '/v1/uploads', key: 'create', auth: true, handler: createUpload },
  { method: 'GET', pattern: '/v1/uploads/{job}/part-urls', key: 'partUrls', auth: true, handler: partUrls },
  { method: 'PUT', pattern: '/v1/uploads/{job}/parts/{n}', key: 'part', auth: true, handler: proxiedPart },
  { method: 'POST', pattern: '/v1/uploads/{job}/heartbeat', key: 'heartbeat', auth: true, handler: heartbeat },
  { method: 'POST', pattern: '/v1/uploads/{job}/complete', key: 'complete', auth: true, handler: complete },
  { method: 'PUT', pattern: '/__r2/{job}/{n}', key: 'r2', auth: false, handler: r2Put },
];
