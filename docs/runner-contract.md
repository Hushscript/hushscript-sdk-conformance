# Runner contract

What an SDK's conformance runner does with this suite. The mock decides how the server behaves; the runner decides how the SDK is driven. Everything the mock can check about requests it checks itself (`GET /__verify`), so a runner only compares results and errors.

## 1. Starting the mock

The mock is a zero-dependency Node HTTP server.

```sh
node mock/server.mjs --port 4010 --host 127.0.0.1   # prints "READY 4010" on stdout once listening
```

`--port 0` picks a free port and prints it in the READY line. The image built from the repo's `Dockerfile` listens on `0.0.0.0:4010` and has a healthcheck on `GET /__health`.

SDK repos run it as the `mock` compose service and put their `test`, `conformance` and `examples` services in its network namespace (`network_mode: "service:mock"`), so the SDK talks to `http://127.0.0.1:4010` and has no other network. Part URLs the mock mints point at `http://127.0.0.1:<port>/__r2/...`, which works for the same reason.

Constants every runner uses:

| Name | Value |
|---|---|
| Base URL | `http://127.0.0.1:4010` |
| `TEST_TOKEN` | `hsr1:eu:pat.` + `0123456789abcdef` x2 + `.` + `fedcba9876543210` x4 |
| Seeded signup | id `sg_conformance`, claim secret `cs_conformance_secret` |
| Current terms version | `2026-10-01` |

The mock accepts any bearer token that starts with `hsr` and has not been revoked by a rotate. A scenario value of `"$TOKEN"` means `TEST_TOKEN`.

## 2. Getting the scenarios and media

The SDK container shares the mock's network but not its filesystem, so the mock serves what the runner needs:

| Request | Returns |
|---|---|
| `GET /__scenarios` | `{"scenarios": ["happy-direct", ...]}` |
| `GET /__files/scenarios/<name>.json` | one scenario |
| `GET /__files/fixtures/media/<file>` | media fixture bytes (`media/...` paths in scenarios are relative to `fixtures/`) |
| `GET /__files/fixtures/transcripts/<name>.json` | transcript fixture |
| `GET /__files/fixtures/exports/<file>` | golden output |
| `GET /__files/hints.json` | hints |

Only `scenarios/`, `fixtures/` and `hints.json` are served. A runner downloads what it needs into a scratch directory once per run.

## 3. Control API

All control endpoints are unauthenticated and are not written to the log.

| Endpoint | Does |
|---|---|
| `GET /__health` | `{"ok": true}` |
| `POST /__scenario {"name": "x"}` | Loads `scenarios/x.json`: fresh state, empty log, clock at 0. `{"mock": {...}, "expect": {...}}` loads an ad-hoc scenario (used by the mock's own tests). |
| `POST /__reset` | Back to the empty default scenario. |
| `POST /__mark` | Marks "now" in the log. `noRequests` counts requests after the last mark. Call it right before the final `call`. |
| `GET /__log` | Every API request: `[{method, path, query, bodySha256, headers, route, t, idempotencyKey}]`. `headers.authorization` is `present` or `absent`, never the value. `route` is the OpenAPI path template (`PUT /__r2/{job}/{n}`); `t` is the mock clock in seconds at arrival; `status` is the HTTP status the mock answered with (`null` for a dropped connection, and while a request is still held). |
| `GET /__state` | Counts and lists the mock tracks: `jobs`, `holds` (jobs holding minutes), `pendingHolds` (requests the mock is holding until the clock moves), `nextHoldAt` (the earliest mock time a held request is released, or `null`), `jobList`, `purchases`, `claims`, `rotations`, `balanceSeconds`, `heldSeconds`, `now`. |
| `GET /__verify` | `{"ok": bool, "failures": [string]}`: the request-side half of the scenario's `expect`. |
| `GET /__clock`, `POST /__clock {"advance": seconds}` | Reads or moves the mock clock. Returns `{"now": seconds}`. |

## 4. Running a scenario

For each name from `GET /__scenarios`, in any order:

1. `POST /__scenario {"name": ...}`.
2. If `call.prior` exists, run it first (section 6). It must raise the error in its `expectError`; keep the error's resume token for the final call.
3. `POST /__mark`.
4. Run `call` through the SDK's public API, with the SDK configured for `baseUrl` and `TEST_TOKEN`, an injected clock/sleep (section 5) and default options unless `call.args.options` says otherwise.
5. Compare the outcome with `expect.result` or `expect.error` (section 7).
6. `GET /__verify`; any `failures` fail the scenario. Print them.
7. Report `PASS <name>` or `FAIL <name>: <reasons>`. Exit non-zero if any scenario failed.

A runner must not skip a scenario it cannot run. It fails it.

## 5. Mock clock and injected time

The mock never reads the wall clock. Time moves only through `POST /__clock`. Each SDK exposes an injectable `now()` and `sleep()`, and the runner supplies a virtual clock so nothing waits in real time:

- `sleep(s)` registers a timer at `virtualNow + s` and returns a promise.
- The mock's clock and the SDK's virtual clock are the same number: both start at 0 and only the driver moves them.

#### The driver

While the final `call` is pending, the driver loops. It runs in the same process as the SDK and wraps the SDK's HTTP transport (the injected `fetch`) to count requests in flight, `inFlight`. A held request is in flight from the SDK's point of view but waiting for the clock, not for work, so the driver subtracts the mock's `pendingHolds`:

1. Yield to the event loop until the SDK is quiet: two consecutive `setImmediate` turns in which `inFlight - pendingHolds` (with `pendingHolds` read from `GET /__state`) stayed 0 and the SDK registered no new timer. That is "the SDK is idle": nothing is being computed or answered, everything left waits for time.
2. Pick the target: the earliest of the SDK's pending virtual timers and `nextHoldAt` from `/__state`. Targets at or before the current time fire without moving the clock.
3. `POST /__clock {"advance": target - now}`, set the SDK's virtual clock to the same value, fire the due timers, go back to 1.
4. If there is no timer and no held request, and the call is still pending after the quiet check, the driver fails the scenario ("SDK stalled") instead of advancing blindly. A call that waits on nothing is a bug in the SDK or the driver, and a blind jump would hide it.

Without the subtraction a driver can never tell "the SDK is waiting for a response the mock will send" (do not advance, the response is coming in real time) from "the SDK is waiting for a response the mock is holding for the clock" (advance). `pendingHolds` is that signal.

`heartbeat-cadence` depends on this. The mock holds each R2 part response for 300 mock seconds (`holdSeconds`), so the SDK's heartbeat timer must fire while parts are in flight. `GET /__verify` then checks that create, every heartbeat and complete are at most 120 s apart in `t`. `minCount: 4` assumes the default concurrency of 4: eight parts in two waves of 300 s make 600 s from create to complete, so at least four heartbeats (at 120, 240, 360 and 480 s). A runner that raises the concurrency changes the arithmetic and fails the scenario for the wrong reason; leave `concurrency` at its default for this scenario.

Pacing and backoff are checked from the same clock. `minGapSeconds` (below) compares the `t` of consecutive requests to a route, so an SDK that retried at once, or that did not wait the spec's 15 s (`rate_limited` with no `Retry-After`) or 30 s (`too_many_active_jobs`), fails. `retry-after-61` checks the opposite: it expects `state.now` to be `0` at the end, so an SDK that slept before raising `RateLimitError` (the driver would have advanced the clock for that sleep) fails.

`wait-timeout-then-resume` and `resume-different-file` rely on the job staying in `processing` until the mock clock reaches a value, so the SDK's polling sleeps must advance the mock clock too.

## 6. Scenario file format

```json
{
  "name": "buy-502-then-ok",
  "description": "optional one-liner",
  "call": { "op": "buy", "args": { "pack": "300min" } },
  "mock": { "purchase": [{ "status": 502 }, { "status": 200 }] },
  "expect": {
    "result": { "seconds": 18000 },
    "requests": { "POST /v1/billing/purchase": 2 },
    "sameIdempotencyKey": "POST /v1/billing/purchase"
  }
}
```

### `call.op` and `args`

| `op` | `args` | The runner calls | `result` is |
|---|---|---|---|
| `transcribe` | `file` (path under `fixtures/`), `options` (TranscribeOptions, camelCase) | `hs.transcribe(file, options)` | `{id, title, language, durationSeconds, utteranceCount, text, raw}`; `text` is `toText()`, `raw` is `toJSON()` |
| `resume` | `file` | `hs.resume(token, file)` with the token from `prior`'s error | same as `transcribe` |
| `balance` | none | `hs.balance()` | `{seconds, minutes, heldSeconds, expiresAt}` |
| `listTranscripts` | `pageSize?` | `hs.transcripts.list()` drained | `{count, firstId, lastId}` |
| `getTranscript` | `id` | `hs.transcripts.get(id)` | as `transcribe` |
| `buy` | `pack` | `hs.buy(pack)` | as `balance` |
| `claim` | `signupId`, `claimSecret` | `Hushscript.agent.claim(...)` | `{token, userId, scopes, seconds}` |
| `rotate` | none | `hs.agent.rotateToken()` | `{token, tokenId, scopes}` |
| `probe` | `toleranceSeconds` | the SDK's duration probe on every key of `fixtures/media/durations.json` | `{checked, failures}`; a failure is `{file, expected, got}` |
| `format` | none | every transcript fixture through `toSRT`/`toVTT`/`toText` for every golden in `fixtures/exports/`; names follow the README | `{checked, mismatches}`; a mismatch is the golden's file name |

The `transcribe` file is read from disk by the SDK, so a runner that works from the mock's `/__files` downloads it first. `resume` takes the file as its second argument (spec 6.1, 9.2). The SDK refuses a file whose size differs from the token's with `ResumeMismatchError` (`resume_file_mismatch`, no request sent). The file is needed only while the job is still `uploading`; a resume past that works without one, and a resume that needs a file and gets none raises `ResumeMismatchError` with code `resume_file_required`. No scenario exercises the second case yet, so the runner's own tests cover it; the hint text is in `hints.json`.

`call.prior` is a call of the same shape with `expectError` (an error expectation as in section 7). Its requests count toward `requests`, but `noRequests` covers the final call only.

### `mock`: what the mock does

Arrays are scripted steps for one route, consumed in order; unknown keys at any level (mock, rule, `match`) fail the scenario load. A request without valid credentials gets `unauthorized` before the steps are consulted, so it does not consume one. A step is a rule:

| Field | Meaning |
|---|---|
| `status` | Respond with this HTTP status. `>= 400` skips the real handler. `200` means "behave normally for this one request". With no `error`, the body is the status text as `text/plain` (like an edge 502). |
| `error` | Error slug; the body is `{"error": slug, "code": n}` with code and status from the API's error catalog. |
| `extra` | Extra body keys (`needed_seconds`, `details`, ...). |
| `headers` | Response headers (`Retry-After`). |
| `echoToken` | Put the received bearer token in `details`. |
| `drop` | `after-read`: destroy the socket after reading the request, change nothing. `after-commit`: run the handler, then destroy the socket. |
| `holdSeconds` | Hold the request until the mock clock has advanced this far. |
| `times` | How many requests the rule applies to: a number (default 1) or `"always"`. |
| `match` | `{n: 2}` applies only to part 2; `{afterDirectSuccess: true}` only once a direct PUT has succeeded. Both can be combined. |

Route keys: `create`, `partUrls`, `r2` (direct part PUTs), `part` (proxied part PUTs), `heartbeat`, `complete`, `job`, `jobs`, `transcript`, `transcripts`, `deleted`, `balance` (`GET /v1/account`), `packs`, `cards`, `defaultCard`, `purchase`, `setupSession`, `signup`, `claim`, `rotate`.

Configuration keys:

| Key | Meaning |
|---|---|
| `account` | `balance_seconds` (default 0), `held_seconds`, `max_daily_seconds`, `max_active_jobs`, `active_jobs`, `used_today_seconds`, `card_on_file`, `data_region`, `credits_expire_at`, `agent` (adds `purchases_remaining_in_window`, marks packs `available`) |
| `upload` | `null`: the create response has `upload: null` (proxied mode). Otherwise `{parts: 3, expireFirstPage, loseParts: [n], verifiedSeconds}`. The mock derives `part_size_bytes` from `size_bytes` so the file splits into exactly `parts` parts, and `part-urls` pages hold 16 URLs. `expireFirstPage` mints the create response's URLs already expired. `loseParts` acknowledges a part and forgets it. |
| `cardList` | `{default_id, methods}` replaces the two default cards (`pm_conf_default` is the default). |
| `fixture` | Transcript fixture served for finished jobs (default `one-speaker`). |
| `listing` | `{count}`: `GET /v1/transcripts` pages over this many synthetic rows. Cursors are opaque and signed; anything else is `bad_request`. |
| `jobFlow` | Phases `GET /v1/jobs/{id}` walks after complete. A phase is `{state, polls?, untilClock?, error?, failure_kind?}`; it ends after `polls` reads or when the clock reaches `untilClock`; the last phase is sticky. Default: `processing` once, then `done`. |
| `completeState` | State complete returns (default `queued`). |
| `forwardCompat` | Adds unknown fields (`x_unknown_field`, `confidence`) to responses. |

What the mock enforces on its own, so a buggy SDK fails without the scenario saying so: Authorization on every `/v1` route except signup and claim; R2 PUTs with no Authorization, an exact `Content-Length`, a valid unexpired signature and the exact part size; sorted `parts` in complete with matching unquoted ETags; no `parts` body for proxied jobs; idempotent create and purchase replays; the key rules (16 to 128 printable ASCII for uploads, `[A-Za-z0-9_-]{1,128}` for purchases).

### `expect`

Evaluated by the runner:

| Key | Meaning |
|---|---|
| `result` | Subset match against the op's result: objects match key by key, arrays match element by element at equal length, scalars are equal. |
| `error` | The call must raise. Fields: `class` (instanceof the named class; `HushscriptError` accepts any SDK error), `code` (slug), `numericCode`, `status` (`null` for SDK-side errors), `details` (subset match, camelCased keys), `retryAfter`, `hintContains`, `fields` (class attributes; the string `<present>` means non-empty), `messageExcludes` (strings that must appear nowhere in the error's message, hint, details, cause or string form; `$TOKEN` is `TEST_TOKEN`). |

Evaluated by the mock in `GET /__verify` (request counts are over the whole scenario, `prior` included):

| Key | Meaning |
|---|---|
| `requests`, `requestsAtLeast`, `requestsAtMost` | Route (`METHOD template`) to count. |
| `noRequests` | The final call sent nothing. |
| `sameIdempotencyKey` | Every request to this route carried the same key. |
| `authorization` | Route to `present` or `absent` on every request. |
| `queries` | Route to the ordered query strings of its requests; `"*"` matches any non-empty value. |
| `state` | Subset match against `/__state`. |
| `heartbeat` | `{maxGapSeconds, minCount}` over create, heartbeats and complete. |
| `minGapSeconds` | Route to the least mock seconds between consecutive requests to it (by `t`). Needs at least two requests. |

## 7. Reporting

Print one line per scenario, `PASS name` or `FAIL name: reason`, then a summary. Exit code 0 only if every scenario passed. CI calls this through the SDK's `just conformance`.
