// @ts-check
import { startMock } from '../server.mjs';

export const TEST_TOKEN = `hsr1:eu:pat.${'0123456789abcdef'.repeat(2)}.${'fedcba9876543210'.repeat(4)}`;

/**
 * @typedef {object} Reply
 * @property {number} status
 * @property {Headers} headers
 * @property {string} text
 * @property {any} json
 */

/** @typedef {{ json?: unknown, body?: Uint8Array | string, headers?: Record<string, string>, auth?: boolean }} ApiOptions */
/** @typedef {(method: string, path: string, opts?: ApiOptions) => Promise<Reply>} Api */
/** @typedef {{ base: string, port: number, api: Api, scenario: (name: string) => Promise<Reply>, advance: (seconds: number) => Promise<Reply> }} Mock */

/**
 * @param {(mock: Mock) => Promise<void>} fn
 * @param {{ scenariosDir?: string }} [options]
 */
export async function withMock(fn, options = {}) {
  const running = await startMock({ port: 0, host: '127.0.0.1', ...options });
  const base = `http://127.0.0.1:${running.port}`;
  /** @type {Api} */
  const api = async (method, path, opts = {}) => {
    /** @type {Record<string, string>} */
    const headers = { ...opts.headers };
    if (opts.auth !== false) headers['authorization'] = `Bearer ${TEST_TOKEN}`;
    /** @type {string | Uint8Array | undefined} */
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    /** @type {any} */
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // the body is not JSON; callers read `text`
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  const scenario = (/** @type {string} */ name) => api('POST', '/__scenario', { json: { name }, auth: false });
  const advance = (/** @type {number} */ seconds) =>
    api('POST', '/__clock', { json: { advance: seconds }, auth: false });
  try {
    await fn({ base, port: running.port, api, scenario, advance });
  } finally {
    await running.close();
  }
}

export const FILE_SIZE = 161037;

/**
 * @param {Api} api
 * @param {{ size?: number, duration?: number, key?: string }} [opts]
 */
export function createJob(api, opts = {}) {
  return api('POST', '/v1/uploads', {
    json: {
      size_bytes: opts.size ?? FILE_SIZE,
      duration_seconds: opts.duration ?? 21,
      idempotency_key: opts.key ?? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    },
  });
}

/**
 * @param {{ part_size_bytes: number, part_urls: { n: number, url: string }[] }} upload
 * @param {number} n
 * @param {number} [size]
 */
export function partBytes(upload, n, size = FILE_SIZE) {
  const last = size - (upload.part_urls.length - 1) * upload.part_size_bytes;
  return new Uint8Array(n === upload.part_urls.length ? last : upload.part_size_bytes).fill(n);
}

/**
 * Loads an ad-hoc scenario: a `mock` block and an optional `expect` block.
 * @param {Mock} m
 * @param {unknown} mock
 * @param {unknown} [expect]
 */
export async function select(m, mock, expect) {
  const res = await m.api('POST', '/__scenario', { json: { mock, expect }, auth: false });
  if (res.status !== 200) throw new Error(`scenario load failed: ${res.text}`);
}
