// @ts-check
import { createHash } from 'node:crypto';
import { BASE_EPOCH, CURRENT_TERMS_VERSION } from '../state.mjs';
import { errorReply, field, isRecord } from '../util.mjs';
import { PACKS } from './account.mjs';

/** @typedef {import('../types.js').Ctx} Ctx */
/** @typedef {import('../types.js').State} State */
/** @typedef {import('../types.js').Reply} Reply */
/** @typedef {import('../types.js').RouteDef} RouteDef */

const SCOPES = ['account:read', 'transcribe', 'transcripts:read', 'billing'];

/**
 * @param {State} state
 * @returns {string}
 */
function mintToken(state) {
  state.tokenSeq += 1;
  const digest = (/** @type {string} */ label) =>
    createHash('sha256').update(`${label}|${state.tokenSeq}`).digest('hex');
  return `hsr1:eu:pat.${digest('a').slice(0, 32)}.${digest('b')}`;
}

/** @param {Ctx} ctx @returns {Reply} */
function signup(ctx) {
  const { state } = ctx;
  const body = ctx.json;
  if (!isRecord(body)) return errorReply('bad_request');
  if (typeof body['contact_email'] !== 'string' || !isRecord(body['agent'])) return errorReply('bad_request');
  if (body['accept_terms_version'] !== CURRENT_TERMS_VERSION) {
    return errorReply('policy_version_stale', { details: { current_version: CURRENT_TERMS_VERSION } });
  }
  const pack = PACKS.find((candidate) => candidate.id === body['pack_id']);
  if (pack === undefined) return errorReply('unknown_pack');
  if (pack.id !== '45min' && pack.id !== '300min') return errorReply('agent_pack_locked');
  const id = `sg_conf_${String(state.signups.size).padStart(3, '0')}`;
  const secret = `cs_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  if (body['dry_run'] !== true) state.signups.set(id, { id, secret, pack: pack.id, claimed: false });
  return {
    status: 200,
    json: {
      signup_id: id,
      claim_secret: secret,
      checkout_url: `https://checkout.example.com/pay/${id}`,
      pack: pack.id,
      amount: pack.amount,
      currency: pack.currency,
      expires_at: BASE_EPOCH + state.now + 1800,
    },
  };
}

/** @param {Ctx} ctx @returns {Reply} */
function claim(ctx) {
  const { state } = ctx;
  const found = state.signups.get(ctx.params['signup_id'] ?? '');
  const secret = field(ctx.json, 'claim_secret');
  if (found === undefined || found.claimed || secret !== found.secret) return errorReply('agent_claim_invalid');
  found.claimed = true;
  state.claims += 1;
  const pack = PACKS.find((candidate) => candidate.id === found.pack);
  state.balanceSeconds += pack?.seconds ?? 0;
  return {
    status: 200,
    json: {
      user_id: `usr_conf_${String(state.claims).padStart(3, '0')}`,
      pat: mintToken(state),
      scopes: SCOPES,
      balance_seconds: state.balanceSeconds,
    },
  };
}

/** @param {Ctx} ctx @returns {Reply} */
function rotate(ctx) {
  const { state } = ctx;
  if (ctx.token !== null) state.revoked.add(ctx.token);
  state.rotations += 1;
  return {
    status: 200,
    json: { pat: mintToken(state), pat_id: `pat_conf_${String(state.rotations).padStart(3, '0')}`, scopes: SCOPES },
  };
}

/** @type {RouteDef[]} */
export const agentRoutes = [
  { method: 'POST', pattern: '/v1/agent/accounts', key: 'signup', auth: false, handler: signup },
  { method: 'POST', pattern: '/v1/agent/accounts/{signup_id}/claim', key: 'claim', auth: false, handler: claim },
  { method: 'POST', pattern: '/v1/agent/credentials/rotate', key: 'rotate', auth: true, handler: rotate },
];
