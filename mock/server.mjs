// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { accountRoutes } from './routes/account.mjs';
import { agentRoutes } from './routes/agent.mjs';
import { jobRoutes } from './routes/jobs.mjs';
import { uploadRoutes } from './routes/uploads.mjs';
import { advanceClock, createState, pickRule, waitForClock } from './state.mjs';
import { errorReply, field, isInt, isRecord, parseJson } from './util.mjs';
import { stateSummary, verify } from './verify.mjs';

/** @typedef {import('./types.js').State} State */
/** @typedef {import('./types.js').Reply} Reply */
/** @typedef {import('./types.js').Rule} Rule */
/** @typedef {import('./types.js').RouteDef} RouteDef */
/** @typedef {import('./types.js').Ctx} Ctx */
/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_JSON_BYTES = 1024 * 1024;
const ROUTES = [...uploadRoutes, ...jobRoutes, ...accountRoutes, ...agentRoutes];
const MIME = new Map([
  ['.json', 'application/json'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.srt', 'text/plain; charset=utf-8'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * @param {string} pattern
 * @param {string} path
 * @returns {Record<string, string> | null}
 */
function matchPattern(pattern, path) {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? '';
    if (segment.startsWith('{') && segment.endsWith('}')) {
      if (actual === '') return null;
      params[segment.slice(1, -1)] = decodeURIComponent(actual);
    } else if (segment !== actual) return null;
  }
  return params;
}

/**
 * @param {IncomingMessage} req
 * @param {boolean} keep
 */
async function readBody(req, keep) {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  for await (const buffer of /** @type {AsyncIterable<Buffer>} */ (req)) {
    sha.update(buffer);
    md5.update(buffer);
    length += buffer.length;
    if (keep && length <= MAX_JSON_BYTES) chunks.push(buffer);
  }
  return {
    length,
    sha256: sha.digest('hex'),
    md5: md5.digest('hex'),
    text: keep && length <= MAX_JSON_BYTES ? Buffer.concat(chunks).toString('utf8') : '',
  };
}

/**
 * @param {ServerResponse} res
 * @param {Reply} reply
 * @returns {undefined}
 */
function send(res, reply) {
  /** @type {Record<string, string>} */
  const headers = { ...reply.headers };
  let body = '';
  if (reply.text === undefined) {
    if ('json' in reply) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(reply.json);
    }
  } else {
    headers['content-type'] = reply.contentType ?? 'text/plain; charset=utf-8';
    body = reply.text;
  }
  headers['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(reply.status, headers);
  res.end(body);
  return undefined;
}

/**
 * @param {Rule} rule
 * @param {string | null} token
 * @returns {Reply}
 */
function injectedReply(rule, token) {
  const status = rule.status ?? 500;
  /** @type {Reply} */
  let reply;
  if (rule.error === undefined) {
    reply = { status, text: rule.text ?? STATUS_CODES[status] ?? 'Error' };
  } else {
    /** @type {Record<string, unknown>} */
    const extra = { ...rule.extra };
    if (rule.echoToken === true) {
      extra['details'] = { received_authorization: `Bearer ${token ?? ''}`, token: token ?? '' };
    }
    reply = errorReply(rule.error, extra);
    reply.status = rule.status ?? reply.status;
  }
  reply.headers = { ...rule.headers };
  return reply;
}

/**
 * @param {IncomingMessage} req
 * @returns {string | null}
 */
function bearerToken(req) {
  const value = req.headers.authorization;
  if (value === undefined) return null;
  const match = /^Bearer (\S+)$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * @param {string} rawPath
 * @returns {{ file: string, type: string } | null}
 */
function resolveServedFile(rawPath) {
  const target = resolve(ROOT, rawPath);
  const allowed = ['scenarios', 'fixtures'].some((dir) => target.startsWith(join(ROOT, dir) + sep));
  if (!allowed && target !== join(ROOT, 'hints.json')) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return { file: target, type: MIME.get(extname(target)) ?? 'application/octet-stream' };
}

/**
 * @param {string} name
 * @param {string} dir
 * @returns {Record<string, unknown> | null}
 */
function readScenario(name, dir) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  const parsed = parseJson(readFileSync(file, 'utf8'));
  return isRecord(parsed) ? parsed : null;
}

/**
 * @param {{ port?: number, host?: string, scenariosDir?: string }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startMock(options = {}) {
  const scenariosDir = options.scenariosDir ?? join(ROOT, 'scenarios');
  /** @type {State} */
  let state = createState('', null, undefined, undefined);

  /**
   * @param {string | null} scenario
   * @param {unknown} mock
   * @param {unknown} expect
   */
  const load = (scenario, mock, expect) => {
    for (const waiter of state.waiters) waiter.release();
    state = createState(state.origin, scenario, mock, expect);
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} path
   * @param {Record<string, string>} query
   * @returns {Promise<void>}
   */
  const control = async (req, res, path, query) => {
    const method = req.method ?? 'GET';
    const body = await readBody(req, true);
    const json = parseJson(body.text);
    if (path === '/__health') {
      send(res, { status: 200, json: { ok: true } });
      return;
    }
    if (path === '/__log') {
      send(res, { status: 200, json: state.log });
      return;
    }
    if (path === '/__state') {
      send(res, { status: 200, json: stateSummary(state) });
      return;
    }
    if (path === '/__verify') {
      send(res, { status: 200, json: verify(state) });
      return;
    }
    if (path === '/__reset' && method === 'POST') {
      load(null, undefined, undefined);
      send(res, { status: 200, json: { ok: true } });
      return;
    }
    if (path === '/__mark' && method === 'POST') {
      state.markIndex = state.log.length;
      send(res, { status: 200, json: { ok: true, index: state.markIndex } });
      return;
    }
    if (path === '/__clock') {
      if (method === 'POST') {
        const advance = field(json, 'advance');
        if (typeof advance !== 'number' || !Number.isFinite(advance) || advance < 0) {
          send(res, { status: 400, json: { error: 'bad_clock', detail: 'advance must be a number of seconds >= 0' } });
          return;
        }
        advanceClock(state, advance);
      }
      send(res, { status: 200, json: { now: state.now } });
      return;
    }
    if (path === '/__scenarios') {
      const names = readdirSync(scenariosDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .sort();
      send(res, { status: 200, json: { scenarios: names } });
      return;
    }
    if (path === '/__scenario' && method === 'POST') {
      const name = field(json, 'name');
      try {
        if (typeof name === 'string') {
          const scenario = readScenario(name, scenariosDir);
          if (scenario === null) {
            send(res, { status: 404, json: { error: 'unknown_scenario', name } });
            return;
          }
          load(name, scenario['mock'], scenario['expect']);
        } else if (isRecord(json) && 'mock' in json) {
          load('adhoc', json['mock'], json['expect']);
        } else {
          send(res, { status: 400, json: { error: 'bad_request', detail: 'send {name} or {mock}' } });
          return;
        }
      } catch (error) {
        send(res, { status: 400, json: { error: 'bad_scenario', detail: String(error) } });
        return;
      }
      send(res, { status: 200, json: { ok: true, name: state.scenario } });
      return;
    }
    if (path.startsWith('/__files/') && method === 'GET') {
      const served = resolveServedFile(decodeURIComponent(path.slice('/__files/'.length)));
      if (served === null) {
        send(res, { status: 404, json: { error: 'not_found', path: query['path'] ?? path } });
        return;
      }
      res.writeHead(200, { 'content-type': served.type });
      res.end(readFileSync(served.file));
      return;
    }
    send(res, { status: 404, json: { error: 'unknown_control_endpoint', path } });
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {Promise<void>}
   */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    /** @type {Record<string, string>} */
    const query = Object.fromEntries(url.searchParams);
    if (path.startsWith('/__') && !path.startsWith('/__r2/')) return control(req, res, path, query);

    const current = state;
    const body = await readBody(req, method !== 'PUT');
    const json = body.text === '' ? undefined : parseJson(body.text);
    /** @type {RouteDef | undefined} */
    let route;
    /** @type {Record<string, string>} */
    let params = {};
    let pathMatched = false;
    for (const candidate of ROUTES) {
      const found = matchPattern(candidate.pattern, path);
      if (found === null) continue;
      pathMatched = true;
      if (candidate.method !== method) continue;
      route = candidate;
      params = found;
      break;
    }
    const key = field(json, 'idempotency_key');
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(', ') : (value ?? ''),
      ]),
    );
    headers['authorization'] = req.headers.authorization === undefined ? 'absent' : 'present';
    current.log.push({
      method,
      path,
      query,
      bodySha256: body.sha256,
      headers,
      route: route === undefined ? `${method} (unmatched)` : `${method} ${route.pattern}`,
      t: current.now,
      idempotencyKey: typeof key === 'string' ? key : null,
    });
    if (route === undefined) {
      send(res, pathMatched ? { status: 405, json: { error: 'method_not_allowed' } } : errorReply('not_found'));
      return;
    }

    const token = bearerToken(req);
    /** @type {Ctx} */
    const ctx = {
      state: current,
      method,
      path,
      query,
      params,
      headers: req.headers,
      json,
      bodyLength: body.length,
      bodySha256: body.sha256,
      bodyMd5: body.md5,
      token,
    };
    const rule = pickRule(current, route.key, params);
    if (rule?.holdSeconds !== undefined && rule.holdSeconds > 0) {
      await waitForClock(current, current.now + rule.holdSeconds);
    }
    if (rule?.drop === 'after-read') {
      req.socket.destroy();
      return;
    }
    if (rule !== null && ((rule.status ?? 200) >= 400 || rule.error !== undefined)) {
      send(res, injectedReply(rule, token));
      return;
    }
    if (route.auth && (token === null || !token.startsWith('hsr') || current.revoked.has(token))) {
      send(res, errorReply('unauthorized'));
      return;
    }
    const reply = await route.handler(ctx);
    if (rule?.drop === 'after-commit') {
      req.socket.destroy();
      return;
    }
    send(res, reply);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((/** @type {unknown} */ error) => {
      if (!res.headersSent)
        send(res, { status: 500, json: { error: 'internal_error', code: 9000, detail: String(error) } });
      else res.destroy();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port ?? 4010, options.host ?? '127.0.0.1', () => {
      resolveListen(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  state.origin = `http://127.0.0.1:${port}`;
  return {
    port,
    close: () =>
      new Promise((resolveClose) => {
        for (const waiter of state.waiters) waiter.release();
        server.close(() => {
          resolveClose();
        });
        server.closeAllConnections();
      }),
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ port: number, host: string, scenariosDir?: string }} */
  const parsed = { port: 4010, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--port' && value !== undefined) parsed.port = Number(value);
    if (argv[i] === '--host' && value !== undefined) parsed.host = value;
    if (argv[i] === '--scenarios' && value !== undefined) parsed.scenariosDir = value;
  }
  if (!isInt(parsed.port) || parsed.port < 0 || parsed.port > 65_535) throw new Error('invalid --port');
  return parsed;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const running = await startMock(parseArgs(process.argv.slice(2)));
  process.stdout.write(`READY ${running.port}\n`);
  const stop = () => {
    void running.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
