// @ts-check
import { BASE_EPOCH, limitsView } from '../state.mjs';
import { errorReply, field, isRecord, withFutureFields } from '../util.mjs';

/** @typedef {import('../types.js').Ctx} Ctx */
/** @typedef {import('../types.js').Reply} Reply */
/** @typedef {import('../types.js').RouteDef} RouteDef */

export const PACKS = [
  { id: '45min', amount: 599, currency: 'USD', seconds: 2700, referral_bonus_seconds: 0 },
  { id: '300min', amount: 3499, currency: 'USD', seconds: 18_000, referral_bonus_seconds: 0 },
  { id: '900min', amount: 8999, currency: 'USD', seconds: 54_000, referral_bonus_seconds: 0 },
  { id: '1800min', amount: 15_999, currency: 'USD', seconds: 108_000, referral_bonus_seconds: 0 },
  { id: '6000min', amount: 44_999, currency: 'USD', seconds: 360_000, referral_bonus_seconds: 0 },
];

/** @param {Ctx} ctx @returns {Reply} */
function account(ctx) {
  const { state } = ctx;
  const cfg = state.config.account ?? {};
  /** @type {Record<string, unknown>} */
  const body = {
    balance_seconds: state.balanceSeconds,
    held_seconds: state.heldSeconds,
    credits_expire_at: cfg.credits_expire_at ?? null,
    card_on_file: cfg.card_on_file ?? state.cards.methods.length > 0,
    data_region: cfg.data_region ?? 'eu',
    limits: limitsView(state),
  };
  if (cfg.agent === true) body['purchases_remaining_in_window'] = cfg.purchases_remaining_in_window ?? 3;
  return { status: 200, json: withFutureFields(state.config.forwardCompat, body) };
}

/** @param {Ctx} ctx @returns {Reply} */
function packs(ctx) {
  const agent = ctx.state.config.account?.agent === true;
  return {
    status: 200,
    json: {
      packs: PACKS.map((pack) => (agent ? { ...pack, available: pack.id === '45min' || pack.id === '300min' } : pack)),
    },
  };
}

/** @param {Ctx} ctx @returns {Reply} */
function cards(ctx) {
  return { status: 200, json: ctx.state.cards };
}

/** @param {Ctx} ctx @returns {Reply} */
function setDefaultCard(ctx) {
  const id = field(ctx.json, 'payment_method_id');
  const card = ctx.state.cards.methods.find((candidate) => candidate.id === id);
  if (card === undefined) return errorReply('not_found');
  ctx.state.cards = {
    default_id: card.id,
    methods: ctx.state.cards.methods.map((candidate) => ({ ...candidate, is_default: candidate.id === card.id })),
  };
  return { status: 200, json: { ok: true } };
}

/** @param {Ctx} ctx @returns {Reply} */
function purchase(ctx) {
  const { state } = ctx;
  const body = ctx.json;
  if (!isRecord(body)) return errorReply('bad_request');
  const packId = body['pack'];
  const key = body['idempotency_key'];
  const card = body['quick_payment_method_id'];
  if (typeof key !== 'string' || !/^[\w-]{1,128}$/.test(key)) return errorReply('invalid_idempotency_key');
  const pack = PACKS.find((candidate) => candidate.id === packId);
  if (pack === undefined) return errorReply('unknown_pack');
  if (typeof card !== 'string' || !state.cards.methods.some((candidate) => candidate.id === card)) {
    return errorReply('no_payment_method');
  }
  const replay = state.purchaseResponses.get(key);
  if (replay !== undefined) return { status: 200, json: { status: 'ok', balance_seconds: replay } };
  state.balanceSeconds += pack.seconds;
  state.purchases.push({ pack: pack.id, idempotencyKey: key, quickPaymentMethodId: card });
  state.purchaseResponses.set(key, state.balanceSeconds);
  return { status: 200, json: { status: 'ok', balance_seconds: state.balanceSeconds } };
}

/** @param {Ctx} ctx @returns {Reply} */
function setupSession(ctx) {
  return {
    status: 200,
    json: {
      checkout_url: 'https://checkout.example.com/setup/cs_conformance',
      session_id: 'cs_conformance',
      expires_at: BASE_EPOCH + ctx.state.now + 1800,
    },
  };
}

/** @type {RouteDef[]} */
export const accountRoutes = [
  { method: 'GET', pattern: '/v1/account', key: 'balance', auth: true, handler: account },
  { method: 'GET', pattern: '/v1/billing/packs', key: 'packs', auth: true, handler: packs },
  { method: 'GET', pattern: '/v1/billing/cards', key: 'cards', auth: true, handler: cards },
  { method: 'POST', pattern: '/v1/billing/cards/default', key: 'defaultCard', auth: true, handler: setDefaultCard },
  { method: 'POST', pattern: '/v1/billing/purchase', key: 'purchase', auth: true, handler: purchase },
  { method: 'POST', pattern: '/v1/billing/setup-session', key: 'setupSession', auth: true, handler: setupSession },
];
