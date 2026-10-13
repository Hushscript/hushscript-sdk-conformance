// @ts-check
import { isRecord } from './util.mjs';

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').LogEntry} LogEntry */

const HEARTBEAT = 'POST /v1/uploads/{job}/heartbeat';

/**
 * @param {State} state
 */
export function stateSummary(state) {
  const jobs = [...state.jobs.values()];
  return {
    now: state.now,
    scenario: state.scenario,
    jobs: jobs.length,
    holds: jobs.filter((job) => job.holdActive).length,
    pendingHolds: state.waiters.length,
    nextHoldAt: state.waiters.length === 0 ? null : Math.min(...state.waiters.map((waiter) => waiter.at)),
    jobList: jobs.map((job) => ({
      id: job.id,
      state: job.state,
      idempotencyKey: job.key,
      declaredSeconds: job.declaredSeconds,
      parts: job.parts.size,
      heartbeats: job.heartbeats,
    })),
    purchases: state.purchases,
    claims: state.claims,
    rotations: state.rotations,
    balanceSeconds: state.balanceSeconds,
    heldSeconds: state.heldSeconds,
  };
}

/**
 * Subset match: objects match key by key, arrays match element by element at equal length.
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {boolean}
 */
export function subsetMatch(expected, actual) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => subsetMatch(item, actual[index]))
    );
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => subsetMatch(value, actual[key]));
  }
  return expected === actual;
}

/**
 * @param {LogEntry[]} entries
 * @param {string} route
 */
function forRoute(entries, route) {
  return entries.filter((entry) => entry.route === route);
}

/**
 * Evaluates the request-side half of the loaded scenario's `expect` block.
 * @param {State} state
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function verify(state) {
  const { expect, log } = state;
  /** @type {string[]} */
  const failures = [];

  for (const [route, want] of Object.entries(expect.requests ?? {})) {
    const got = forRoute(log, route).length;
    if (got !== want) failures.push(`${route}: expected ${want} requests, got ${got}`);
  }
  for (const [route, want] of Object.entries(expect.requestsAtLeast ?? {})) {
    const got = forRoute(log, route).length;
    if (got < want) failures.push(`${route}: expected at least ${want} requests, got ${got}`);
  }
  for (const [route, want] of Object.entries(expect.requestsAtMost ?? {})) {
    const got = forRoute(log, route).length;
    if (got > want) failures.push(`${route}: expected at most ${want} requests, got ${got}`);
  }
  if (expect.noRequests === true) {
    const got = log.length - state.markIndex;
    if (got !== 0) failures.push(`expected no requests from the final call, got ${got}`);
  }
  if (expect.sameIdempotencyKey !== undefined) {
    const keys = forRoute(log, expect.sameIdempotencyKey).map((entry) => entry.idempotencyKey);
    if (keys.length === 0) failures.push(`${expect.sameIdempotencyKey}: no requests to compare keys on`);
    else if (keys.some((key) => key === null || key !== keys[0])) {
      failures.push(`${expect.sameIdempotencyKey}: idempotency keys differ: ${JSON.stringify(keys)}`);
    }
  }
  for (const [route, want] of Object.entries(expect.authorization ?? {})) {
    const entries = forRoute(log, route);
    if (entries.length === 0) failures.push(`${route}: no requests to check Authorization on`);
    for (const entry of entries) {
      if (entry.headers['authorization'] !== want) failures.push(`${route}: Authorization should be ${want}`);
    }
  }
  for (const [route, wanted] of Object.entries(expect.queries ?? {})) {
    const got = forRoute(log, route).map((entry) => entry.query);
    if (got.length !== wanted.length) {
      failures.push(`${route}: expected ${wanted.length} requests with queries, got ${got.length}`);
      continue;
    }
    for (const [index, want] of wanted.entries()) {
      for (const [key, value] of Object.entries(want)) {
        const actual = got[index]?.[key];
        const matches = value === '*' ? actual !== undefined && actual !== '' : actual === value;
        if (!matches) failures.push(`${route} #${index + 1}: query ${key} expected ${value}, got ${String(actual)}`);
      }
    }
  }
  if (expect.state !== undefined && !subsetMatch(expect.state, JSON.parse(JSON.stringify(stateSummary(state))))) {
    failures.push(`state mismatch: wanted ${JSON.stringify(expect.state)}, got ${JSON.stringify(stateSummary(state))}`);
  }
  for (const [route, want] of Object.entries(expect.minGapSeconds ?? {})) {
    const times = forRoute(log, route).map((entry) => entry.t);
    if (times.length < 2) failures.push(`${route}: minGapSeconds needs at least 2 requests, got ${times.length}`);
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
      if (gap < want)
        failures.push(`${route}: request ${i + 1} came ${gap} s after the previous, wanted at least ${want} s`);
    }
  }
  if (expect.heartbeat !== undefined) {
    const beats = forRoute(log, HEARTBEAT).map((entry) => entry.t);
    const start = forRoute(log, 'POST /v1/uploads')[0]?.t;
    const end = forRoute(log, 'POST /v1/uploads/{job}/complete').at(-1)?.t;
    if (beats.length < expect.heartbeat.minCount) {
      failures.push(`heartbeat: expected at least ${expect.heartbeat.minCount}, got ${beats.length}`);
    }
    const timeline = [...(start === undefined ? [] : [start]), ...beats, ...(end === undefined ? [] : [end])];
    for (let i = 1; i < timeline.length; i++) {
      const gap = (timeline[i] ?? 0) - (timeline[i - 1] ?? 0);
      if (gap > expect.heartbeat.maxGapSeconds)
        failures.push(`heartbeat: gap of ${gap} s exceeds ${expect.heartbeat.maxGapSeconds} s`);
    }
  }
  return { ok: failures.length === 0, failures };
}
