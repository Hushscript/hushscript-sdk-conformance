// @ts-check
import { statSync } from 'node:fs';
import { isRecord } from './util.mjs';

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Rule} Rule */
/** @typedef {import('./types.js').MockConfig} MockConfig */
/** @typedef {import('./types.js').Job} Job */

export const BASE_EPOCH = 1_760_000_000;
export const TEST_TOKEN = `hsr1:eu:pat.${'0123456789abcdef'.repeat(2)}.${'fedcba9876543210'.repeat(4)}`;
export const CURRENT_TERMS_VERSION = '2026-10-01';
export const SEEDED_SIGNUP = { id: 'sg_conformance', secret: 'cs_conformance_secret' };
export const DEFAULT_CARD_ID = 'pm_conf_default';

export const STEP_KEYS = [
  'create',
  'partUrls',
  'r2',
  'part',
  'heartbeat',
  'complete',
  'job',
  'jobs',
  'transcript',
  'transcripts',
  'deleted',
  'balance',
  'packs',
  'cards',
  'defaultCard',
  'purchase',
  'setupSession',
  'signup',
  'claim',
  'rotate',
];
export const CONFIG_KEYS = [
  'account',
  'cardList',
  'upload',
  'fixture',
  'expectedUploadFile',
  'listing',
  'jobFlow',
  'completeState',
  'forwardCompat',
];

export const RULE_KEYS = [
  'status',
  'error',
  'extra',
  'headers',
  'text',
  'echoToken',
  'drop',
  'holdSeconds',
  'times',
  'match',
];
export const MATCH_KEYS = ['n', 'afterDirectSuccess'];

/** @returns {{ default_id: string | null, methods: import('./types.js').CardRow[] }} */
function defaultCards() {
  return {
    default_id: DEFAULT_CARD_ID,
    methods: [
      {
        id: 'pm_conf_other',
        type: 'card',
        brand: 'mastercard',
        last4: '4444',
        exp_month: 6,
        exp_year: 2099,
        email: null,
        is_default: false,
        fast_checkout_eligible: true,
      },
      {
        id: DEFAULT_CARD_ID,
        type: 'card',
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2099,
        email: null,
        is_default: true,
        fast_checkout_eligible: true,
      },
    ],
  };
}

/**
 * Splits a scenario's `mock` block into scripted routes and configuration, rejecting unknown keys.
 * @param {unknown} raw
 * @returns {{ config: MockConfig, rules: Record<string, Rule[]> }}
 */
export function loadMock(raw) {
  if (raw === undefined) return { config: {}, rules: {} };
  if (!isRecord(raw)) throw new Error('mock must be an object');
  /** @type {Record<string, unknown>} */
  const config = {};
  /** @type {Record<string, Rule[]>} */
  const rules = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STEP_KEYS.includes(key)) {
      if (!Array.isArray(value)) throw new Error(`mock.${key} must be an array of steps`);
      /** @type {Rule[]} */
      const steps = [];
      for (const [index, step] of /** @type {unknown[]} */ (value).entries()) {
        if (!isRecord(step)) throw new Error(`mock.${key}[${index}] must be an object`);
        for (const stepKey of Object.keys(step)) {
          if (!RULE_KEYS.includes(stepKey)) throw new Error(`unknown rule key: mock.${key}[${index}].${stepKey}`);
        }
        const match = step['match'];
        if (match !== undefined) {
          if (!isRecord(match)) throw new Error(`mock.${key}[${index}].match must be an object`);
          for (const matchKey of Object.keys(match)) {
            if (!MATCH_KEYS.includes(matchKey)) {
              throw new Error(`unknown match key: mock.${key}[${index}].match.${matchKey}`);
            }
          }
        }
        steps.push(/** @type {Rule} */ (step));
      }
      rules[key] = steps;
    } else if (CONFIG_KEYS.includes(key)) {
      config[key] = value;
    } else {
      throw new Error(`unknown mock key: ${key}`);
    }
  }
  const file = config['expectedUploadFile'];
  if (file !== undefined) {
    if (typeof file !== 'string' || !/^media\/[\w-]+\.[A-Za-z0-9]+$/.test(file)) {
      throw new Error('expectedUploadFile must name a media fixture');
    }
    if (!statSync(new URL(`../fixtures/${file}`, import.meta.url)).isFile()) {
      throw new Error('expectedUploadFile must name a media fixture');
    }
  }
  return { config: /** @type {MockConfig} */ (config), rules };
}

/**
 * @param {string} origin
 * @param {string | null} scenario
 * @param {unknown} rawMock
 * @param {unknown} rawExpect
 * @returns {State}
 */
export function createState(origin, scenario, rawMock, rawExpect) {
  const { config, rules } = loadMock(rawMock);
  return {
    origin,
    scenario,
    config,
    rules,
    expect: isRecord(rawExpect) ? /** @type {import('./types.js').Expect} */ (rawExpect) : {},
    now: 0,
    log: [],
    markIndex: 0,
    jobs: new Map(),
    jobSeq: 0,
    keyIndex: new Map(),
    balanceSeconds: config.account?.balance_seconds ?? 0,
    heldSeconds: config.account?.held_seconds ?? 0,
    purchases: [],
    purchaseResponses: new Map(),
    signups: new Map([
      [SEEDED_SIGNUP.id, { id: SEEDED_SIGNUP.id, secret: SEEDED_SIGNUP.secret, pack: '45min', claimed: false }],
    ]),
    claims: 0,
    rotations: 0,
    tokenSeq: 0,
    revoked: new Set(),
    ruleUses: new Map(),
    directSuccesses: 0,
    waiters: [],
    cards: config.cardList ?? defaultCards(),
  };
}

/**
 * The mock's only notion of time. It moves when a client says so.
 * @param {State} state
 * @param {number} seconds
 */
export function advanceClock(state, seconds) {
  state.now += seconds;
  const due = state.waiters.filter((waiter) => waiter.at <= state.now);
  state.waiters = state.waiters.filter((waiter) => waiter.at > state.now);
  for (const waiter of due) waiter.release();
}

/**
 * @param {State} state
 * @param {number} at
 * @returns {Promise<void>}
 */
export function waitForClock(state, at) {
  if (state.now >= at) return Promise.resolve();
  return new Promise((resolve) => {
    state.waiters.push({ at, release: resolve });
  });
}

/**
 * Picks the first scripted step for a route that still applies.
 * @param {State} state
 * @param {string} key
 * @param {Record<string, string>} params
 * @returns {Rule | null}
 */
export function pickRule(state, key, params) {
  const rules = state.rules[key];
  if (rules === undefined) return null;
  const uses = state.ruleUses.get(key) ?? [];
  state.ruleUses.set(key, uses);
  for (const [index, rule] of rules.entries()) {
    const used = uses[index] ?? 0;
    const limit = rule.times === 'always' ? Number.POSITIVE_INFINITY : (rule.times ?? 1);
    if (used >= limit) continue;
    if (rule.match?.n !== undefined && String(rule.match.n) !== params['n']) continue;
    if (rule.match?.afterDirectSuccess === true && state.directSuccesses === 0) continue;
    uses[index] = used + 1;
    return rule;
  }
  return null;
}

/**
 * @param {State} state
 * @returns {Job[]}
 */
export function activeJobs(state) {
  return [...state.jobs.values()].filter((job) => !['done', 'failed'].includes(job.state));
}

/**
 * @param {State} state
 */
export function limitsView(state) {
  const account = state.config.account ?? {};
  const created = [...state.jobs.values()].reduce((sum, job) => sum + job.declaredSeconds, 0);
  return {
    max_daily_seconds: account.max_daily_seconds ?? 108_000,
    max_active_jobs: account.max_active_jobs ?? 50,
    active_jobs: (account.active_jobs ?? 0) + activeJobs(state).length,
    used_today_seconds: (account.used_today_seconds ?? 0) + created,
  };
}
