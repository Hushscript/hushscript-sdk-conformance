// @ts-check
import { createHash } from 'node:crypto';
import { ERROR_CATALOG } from './errors.mjs';

/** @typedef {import('./types.js').Reply} Reply */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} slug
 * @param {Record<string, unknown>} [extra]
 * @returns {Reply}
 */
export function errorReply(slug, extra = {}) {
  const entry = ERROR_CATALOG[slug];
  if (entry === undefined) throw new Error(`unknown error slug: ${slug}`);
  return { status: entry.status, json: { error: slug, code: entry.code, ...extra } };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * @param {unknown} source
 * @param {string} key
 * @returns {unknown}
 */
export function field(source, key) {
  return isRecord(source) ? source[key] : undefined;
}

/**
 * Adds fields no SDK knows about when the scenario asks for forward-compat checks.
 * @template {Record<string, unknown>} T
 * @param {boolean | undefined} enabled
 * @param {T} object
 * @returns {T}
 */
export function withFutureFields(enabled, object) {
  if (enabled !== true) return object;
  return { ...object, x_unknown_field: { nested: true, list: [1, 2, 3] } };
}
