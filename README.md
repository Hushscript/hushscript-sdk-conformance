# hushscript-sdk-conformance

Shared test suite for the Hushscript SDKs (TypeScript, Python, Go, PHP). Every
SDK runs the same fixtures and goldens, so they agree byte for byte.

Everything runs in containers. Nothing here needs ffmpeg, Node or anything else
on the host except Docker and [just](https://github.com/casey/just).

## Contents

| Path | What |
|---|---|
| `hints.json` | Slug to English hint text, shared by every SDK at build time. |
| `fixtures/hint-rendering.json` | Input to output cases for hint rendering (spec 9.3 rendering rules). See below. |
| `fixtures/media/` | Synthetic sine-tone files (20 s and 61 s in every supported container and codec, plus a 10 s file, a WebM renamed to `.mp3` and a truncated FLAC). `durations.json` holds the true durations. |
| `fixtures/transcripts/` | Synthetic transcript bodies in the `GET /v1/transcripts/{id}` shape. No real content. |
| `fixtures/exports/` | Golden `.srt`, `.vtt` and `.txt` output, one file per transcript and option set. |
| `mock/` | Zero-dependency Node mock of the `/v1` subset the SDKs use, plus a fake R2 part endpoint. |
| `scenarios/` | One JSON file per scenario: the mock's script and the expected outcome. |
| `docs/runner-contract.md` | How an SDK runner drives the mock and checks the outcome. |
| `Dockerfile` | The mock image SDK repos build. |

Golden names are `<transcript>.<variant>.<ext>`. The `translated` transcript
also has `<transcript>.<variant>.es.<ext>` for its Spanish body and `<transcript>.<variant>.cleaned.<ext>` for its cleaned body. Variants:

| Variant | Options |
|---|---|
| `srt-captions`, `vtt-captions` | caption splitting (42 chars, 2 lines, 7000 ms) |
| `srt-plain`, `vtt-plain` | one cue per utterance |
| `txt-default` | speakers on, merge on, no timestamps |
| `txt-nospeakers` | speakers off |
| `txt-timestamps` | `[M:SS]` or `[H:MM:SS]` prefixes |
| `txt-nomerge` | one block per utterance |

## Hint rendering fixture

`fixtures/hint-rendering.json` is an array of cases, one per hint the SDKs must render the same way:

```json
{ "slug": "insufficient_balance", "details": { "needed_seconds": 1250, "balance_seconds": 600 }, "expected": "Not enough minutes: 21 needed, 10 available. ..." }
```

| Field | Meaning |
|---|---|
| `slug` | Key into `hints.json`. A slug missing from `hints.json` renders `null`. |
| `scope` | Optional. The scope the operation needs, for `{scope}`. |
| `details` | The raw values the SDK has in hand, with these snake_case keys and units, whatever the SDK's own naming: `needed_seconds`, `balance_seconds`, `used_seconds`, `max_seconds`, `retry_after_seconds` (whole seconds), `allowed_packs` (array of strings), `current_version`. Every key is optional. |
| `expected` | The rendered hint, or `null`. |

Rendering rules (spec 9.3), which every case pins:

- Split the hint after each `". "`; each sentence keeps its own period. Drop every sentence with a placeholder that has no value. Join what is left with a single space. Nothing left means `null`.
- `{needed}` is `needed_seconds` in minutes rounded up. `{balance}`, `{used}` and `{max}` are `balance_seconds`, `used_seconds` and `max_seconds` in minutes rounded down.
- `{allowedPacks}` joins `allowed_packs` with `", "`. `{retryAfter}` is `retry_after_seconds`. `{currentVersion}` is `current_version`.

A fractional `retry_after_seconds` and an empty `allowed_packs` are not covered; no SDK may rely on them.

## Using this suite from an SDK

Each SDK repo runs the scenarios against the mock in compose. The mock is built from this repo at a pinned tag, sits on an internal network, and the SDK's service shares its network namespace, so the SDK reaches it at `http://127.0.0.1:4010` and has no other network:

```yaml
services:
  mock:
    build:
      context: ${CONFORMANCE_CONTEXT:-https://github.com/Hushscript/hushscript-sdk-conformance.git#v0.1.0}
    init: true
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    pids_limit: 128
    labels:
      sdk.test: "1"
    networks: [sdk]

  conformance:
    image: your-sdk-dev-image
    network_mode: "service:mock"
    depends_on:
      mock:
        condition: service_healthy
    command: ["timeout", "1800", "<your conformance runner>"]

networks:
  sdk:
    internal: true
```

Set `CONFORMANCE_CONTEXT=../hushscript-sdk-conformance` to build from a local checkout. The runner fetches scenarios and media from the mock (`GET /__scenarios`, `GET /__files/...`) and follows `docs/runner-contract.md`.

## Working on the suite

```sh
just test [22|24|26] # mock self-tests on Node 22 (default), 24, or 26
just lint           # every static check, in containers
just ci [22|24|26]   # lint, tests, and a build-and-probe of the mock image
```

## Regenerating

```sh
just media      # rebuild fixtures/media and durations.json (pinned ffmpeg image)
just goldens    # re-render fixtures/exports from the app's own exporters
```

`just goldens` runs the golden renderer test in the Hushscript app repo
(`src/lib/sdkGoldens.render.test.ts`) inside a network-less Node container.
Point `APP_DIR` at an app checkout that has `node_modules` installed
(default `../../app`). The renderer is the source of truth: when the app's
exporters change, regenerate and every SDK follows in its next release.
Regeneration is deliberate. The ffmpeg apt pin in `docker/media.Dockerfile` must be bumped when bookworm ships a newer 5.1.x.

Notes on the media set:

- `vbr-noxing-*.mp3` has no Xing frame, so tools that estimate duration from
  the first frame's bitrate get it wrong. `durations.json` holds the decoded,
  true length.
- `truncated.flac` is the first 4 KiB of `flac-20s.flac` and has no readable
  duration, so it is not listed in `durations.json`.

## License

MIT
