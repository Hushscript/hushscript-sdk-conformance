# Every recipe runs in a container; nothing here touches host toolchains.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`

node_image := "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
app_dir := env_var_or_default("APP_DIR", "../../app")

# regenerate fixtures/media and durations.json inside the pinned ffmpeg image
media:
    docker compose build media
    docker compose run --rm media

# render fixtures/exports from the app's own exporters (needs the app's node_modules)
goldens:
    rm -f fixtures/exports/*
    docker run --rm --init --label sdk.test=1 --cap-drop ALL \
      --security-opt no-new-privileges --network none \
      --user "$(id -u):$(id -g)" --pids-limit 512 --memory 4g \
      --tmpfs /tmp \
      -v "$(realpath "{{app_dir}}")":/app -v "$(pwd)":/out \
      -e SDK_GOLDENS_DIR=/out -e HOME=/tmp -w /app \
      {{node_image}} \
      timeout 600 npx vitest run --maxWorkers=4 src/lib/sdkGoldens.render.test.ts
