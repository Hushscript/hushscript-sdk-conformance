# hushscript-sdk-conformance

Shared test suite for the Hushscript SDKs (TypeScript, Python, Go, PHP). Every
SDK runs the same fixtures and goldens, so they agree byte for byte.

Everything runs in containers. Nothing here needs ffmpeg, Node or anything else
on the host except Docker and [just](https://github.com/casey/just).

## Contents

| Path | What |
|---|---|
| `hints.json` | Slug to English hint text, shared by every SDK at build time. |
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
just test [22|24]   # mock self-tests on Node 22 (default) or 24
just lint           # every static check, in containers
just ci [22|24]     # lint, tests, and a build-and-probe of the mock image
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
