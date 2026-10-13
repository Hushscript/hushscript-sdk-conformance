#!/usr/bin/env bash
# Generates the synthetic media fixtures. Runs only inside the media container
# (`just media`); never on the host.
set -euo pipefail

if ! command -v ffmpeg >/dev/null; then
  echo "run this through 'just media' (ffmpeg lives in the container)" >&2
  exit 1
fi

out="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/media"
mkdir -p "$out"
find "$out" -type f -delete

# Deterministic output: no metadata, bitexact muxing and encoding.
ff() { ffmpeg -nostdin -hide_banner -loglevel error -y -fflags +bitexact -flags +bitexact "$@"; }
tone() { echo "-f lavfi -i sine=frequency=440:sample_rate=16000:duration=$1"; }

for n in 20 61; do
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a libmp3lame -b:a 64k "$out/cbr-${n}s.mp3"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a libmp3lame -q:a 6 "$out/vbr-xing-${n}s.mp3"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a libmp3lame -q:a 6 -write_xing 0 "$out/vbr-noxing-${n}s.mp3"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a aac -b:a 32k "$out/aac-${n}s.m4a"
  # shellcheck disable=SC2046
  ff $(tone "$n") -f lavfi -i "color=c=black:s=64x64:r=5:d=$n" -map_metadata -1 \
    -map 0:a -map 1:v -c:a aac -b:a 32k -c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p \
    -shortest "$out/video-${n}s.mp4"
  # shellcheck disable=SC2046
  ff -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=$n" -ac 1 -map_metadata -1 -c:a pcm_s16le "$out/pcm-${n}s.wav"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a flac "$out/flac-${n}s.flac"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a libvorbis -q:a 0 "$out/vorbis-${n}s.ogg"
  # shellcheck disable=SC2046
  ff $(tone "$n") -ac 1 -map_metadata -1 -c:a libopus -b:a 16k "$out/opus-${n}s.opus"
done

# Edge cases.
# shellcheck disable=SC2046
ff $(tone 10) -ac 1 -map_metadata -1 -c:a libmp3lame -b:a 64k "$out/short-10s.mp3"
# WebM bytes under an .mp3 name.
# shellcheck disable=SC2046
ff $(tone 20) -ac 1 -map_metadata -1 -c:a libopus -b:a 16k -f webm "$out/webm-renamed.mp3"
# First 4 KiB of a FLAC file.
head -c 4096 "$out/flac-20s.flac" >"$out/truncated.flac"

# True durations, in seconds, as ffprobe reads them.
{
  echo "{"
  first=1
  for f in $(find "$out" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort); do
    [ "$f" = durations.json ] && continue
    d="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$out/$f" 2>/dev/null || true)"
    if [[ "$f" == vbr-noxing-* ]]; then
      # Without a Xing frame ffprobe only estimates from the first frame's
      # bitrate, which is wrong for VBR. Decode instead for the true length.
      d="$(ffmpeg -nostdin -v error -i "$out/$f" -f null - -stats 2>&1 | tr '\r' '\n' | sed -n 's/.*time=\([0-9:.]*\).*/\1/p' | tail -1 | awk -F: '{ print $1 * 3600 + $2 * 60 + $3 }')"
    fi
    if [ -z "$d" ] || [ "$d" = "N/A" ]; then
      echo "no duration for $f" >&2
      continue
    fi
    [ $first -eq 1 ] || echo ","
    first=0
    printf '  "%s": %.3f' "$f" "$d"
  done
  echo
  echo "}"
} >"$out/durations.json"
jq -e . "$out/durations.json" >/dev/null
