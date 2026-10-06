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

Golden names are `<transcript>.<variant>.<ext>`. The `translated` transcript
also has `<transcript>.<variant>.es.<ext>` for its Spanish body. Variants:

| Variant | Options |
|---|---|
| `srt-captions`, `vtt-captions` | caption splitting (42 chars, 2 lines, 7000 ms) |
| `srt-plain`, `vtt-plain` | one cue per utterance |
| `txt-default` | speakers on, merge on, no timestamps |
| `txt-nospeakers` | speakers off |
| `txt-timestamps` | `[M:SS]` or `[H:MM:SS]` prefixes |
| `txt-nomerge` | one block per utterance |

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

Notes on the media set:

- `vbr-noxing-*.mp3` has no Xing frame, so tools that estimate duration from
  the first frame's bitrate get it wrong. `durations.json` holds the decoded,
  true length.
- `truncated.flac` is the first 4 KiB of `flac-20s.flac` and has no readable
  duration, so it is not listed in `durations.json`.

## License

MIT
