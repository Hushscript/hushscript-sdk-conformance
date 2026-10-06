# Every recipe runs in a container; nothing here touches host toolchains.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`

node22_image := "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
node24_image := "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
node_image := node22_image
sandbox := "--rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges --pids-limit 512 --memory 4g --tmpfs /tmp"
app_dir := env_var_or_default("APP_DIR", "../../app")

# regenerate fixtures/media and durations.json inside the pinned ffmpeg image
media:
    docker compose build media
    docker compose run --rm media

# render fixtures/exports from the app's own exporters (needs the app's node_modules)
# Renders into a scratch dir and swaps it in only after the render succeeds.
goldens:
    #!/usr/bin/env bash
    set -euo pipefail
    test ! -e fixtures/exports.old || { echo "fixtures/exports.old is left over from an interrupted swap; restore or remove it" >&2; exit 1; }
    tmp="$(mktemp -d -p fixtures .exports-new.XXXXXX)"
    trap 'rm -rf "$tmp"' EXIT
    chmod 755 "$tmp"
    docker run --rm --init --label sdk.test=1 --cap-drop ALL --read-only \
      --security-opt no-new-privileges --network none \
      --user "$(id -u):$(id -g)" --pids-limit 512 --memory 4g \
      --tmpfs /tmp \
      -v "$(realpath "{{app_dir}}")":/app \
      -v "$(pwd)/fixtures":/out/fixtures:ro \
      -v "$(pwd)/$tmp":/out/fixtures/exports \
      -e SDK_GOLDENS_DIR=/out -e HOME=/tmp -w /app \
      {{node_image}} \
      timeout 600 npx vitest run --maxWorkers=4 src/lib/sdkGoldens.render.test.ts
    test -n "$(ls -A "$tmp")" || { echo "render produced no files" >&2; exit 1; }
    mv fixtures/exports fixtures/exports.old
    mv "$tmp" fixtures/exports || { mv fixtures/exports.old fixtures/exports; exit 1; }
    rm -rf fixtures/exports.old
    trap - EXIT

# mock self-tests on Node 22 (default) or 24; no network, repo mounted read-only
test node="22":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{node}}" in 22) image="{{node22_image}}" ;; 24) image="{{node24_image}}" ;; *) echo "node must be 22 or 24" >&2; exit 2 ;; esac
    docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" \
      -v "$(pwd)":/work:ro -w /work -e HOME=/tmp \
      "$image" timeout 300 node --test "mock/test/*.test.mjs"
