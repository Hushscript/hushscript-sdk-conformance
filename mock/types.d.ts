import type { IncomingHttpHeaders } from 'node:http';

export interface Rule {
  status?: number;
  error?: string;
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
  text?: string;
  echoToken?: boolean;
  drop?: 'after-read' | 'after-commit';
  holdSeconds?: number;
  times?: number | 'always';
  match?: { n?: number; afterDirectSuccess?: boolean };
}

export interface Phase {
  state: string;
  polls?: number;
  untilClock?: number;
  error?: string;
  failure_kind?: string;
}

export interface CardRow {
  id: string;
  type: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  email: string | null;
  is_default: boolean;
  fast_checkout_eligible: boolean;
}

export interface AccountConfig {
  balance_seconds?: number;
  held_seconds?: number;
  credits_expire_at?: number | null;
  card_on_file?: boolean;
  data_region?: string;
  max_daily_seconds?: number;
  max_active_jobs?: number;
  active_jobs?: number;
  used_today_seconds?: number;
  agent?: boolean;
  purchases_remaining_in_window?: number;
}

export interface UploadConfig {
  parts?: number;
  expireFirstPage?: boolean;
  loseParts?: number[];
  verifiedSeconds?: number;
}

export interface MockConfig {
  account?: AccountConfig;
  cardList?: { default_id: string | null; methods: CardRow[] };
  upload?: UploadConfig | null;
  fixture?: string;
  listing?: { count: number };
  jobFlow?: Phase[];
  completeState?: string;
  forwardCompat?: boolean;
}

export type Rules = Record<string, Rule[]>;

export interface PartRecord {
  n: number;
  size: number;
  md5: string;
  via: 'direct' | 'proxied';
}

export interface Job {
  id: string;
  seq: number;
  state: string;
  key: string | null;
  size: number;
  declaredSeconds: number;
  title: string | null;
  options: Record<string, unknown>;
  createdAt: number;
  partSize: number | null;
  totalParts: number | null;
  parts: Map<number, PartRecord>;
  heartbeats: number;
  completed: boolean;
  holdActive: boolean;
  verifiedSeconds: number | null;
  error: string | null;
  failureKind: string | null;
  transcriptId: string | null;
  phaseIndex: number;
  phasePolls: number;
  firstPageServed: boolean;
}

export interface LogEntry {
  method: string;
  path: string;
  query: Record<string, string>;
  bodySha256: string;
  headers: Record<string, string>;
  route: string;
  t: number;
  idempotencyKey: string | null;
  status: number | null;
}

export interface Purchase {
  pack: string;
  idempotencyKey: string;
  quickPaymentMethodId: string;
}

export interface Signup {
  id: string;
  secret: string;
  pack: string;
  claimed: boolean;
}

export interface Waiter {
  at: number;
  release: () => void;
}

export interface Expect {
  requests?: Record<string, number>;
  requestsAtLeast?: Record<string, number>;
  requestsAtMost?: Record<string, number>;
  noRequests?: boolean;
  sameIdempotencyKey?: string;
  authorization?: Record<string, 'present' | 'absent'>;
  queries?: Record<string, Record<string, string>[]>;
  state?: Record<string, unknown>;
  heartbeat?: { maxGapSeconds: number; minCount: number };
  minGapSeconds?: Record<string, number>;
}

export interface State {
  origin: string;
  scenario: string | null;
  config: MockConfig;
  rules: Rules;
  expect: Expect;
  now: number;
  log: LogEntry[];
  markIndex: number;
  jobs: Map<string, Job>;
  jobSeq: number;
  keyIndex: Map<string, string>;
  balanceSeconds: number;
  heldSeconds: number;
  purchases: Purchase[];
  purchaseResponses: Map<string, number>;
  signups: Map<string, Signup>;
  claims: number;
  rotations: number;
  tokenSeq: number;
  revoked: Set<string>;
  ruleUses: Map<string, number[]>;
  directSuccesses: number;
  waiters: Waiter[];
  cards: { default_id: string | null; methods: CardRow[] };
}

export interface Reply {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface Ctx {
  state: State;
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  json: unknown;
  bodyLength: number;
  bodySha256: string;
  bodyMd5: string;
  token: string | null;
}

export interface RouteDef {
  method: string;
  pattern: string;
  key: string;
  auth: boolean;
  handler: (ctx: Ctx) => Reply | Promise<Reply>;
}
