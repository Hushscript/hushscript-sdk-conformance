# Every recipe runs in a container; nothing here touches host toolchains.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`

node24_image := "node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c"
node26_image := "node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9"
node_image := node24_image
hadolint_image := "hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"
actionlint_image := "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"
shellcheck_image := "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
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

# mock self-tests on Node 24 (default) or 26; no network, repo mounted read-only
test node="24":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{node}}" in 24) image="{{node24_image}}" ;; 26) image="{{node26_image}}" ;; *) echo "node must be 24 or 26" >&2; exit 2 ;; esac
    docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" \
      -v "$(pwd)":/work:ro -w /work -e HOME=/tmp \
      "$image" timeout 300 node --test "mock/test/*.test.mjs"

# every static check: types, eslint, prettier, hadolint, actionlint, zizmor, shellcheck, gitleaks, typos
lint node="24":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{node}}" in 24) image="{{node24_image}}" ;; 26) image="{{node26_image}}" ;; *) echo "node must be 24 or 26" >&2; exit 2 ;; esac
    run() { docker run {{sandbox}} --network none --user "$(id -u):$(id -g)" -v "$(pwd)":/work:ro -w /work -e HOME=/tmp "$@"; }
    docker build --quiet --target dev --build-arg NODE_IMAGE="$image" -f docker/dev.Dockerfile -t hushscript-sdk-conformance-dev:local .
    docker run {{sandbox}} --network none --label sdk.test=1 hushscript-sdk-conformance-dev:local \
      sh -c 'timeout 300 tsc --noEmit && timeout 300 eslint --max-warnings 0 . && timeout 120 prettier --check "mock/**" "scenarios/**" "*.json" "*.js" ".github/**"'
    run {{hadolint_image}} /bin/hadolint Dockerfile docker/dev.Dockerfile docker/media.Dockerfile docker/typos.Dockerfile
    run {{actionlint_image}} -color
    run {{zizmor_image}} --pedantic --offline .github/workflows
    run {{shellcheck_image}} fixtures/make-media.sh
    run {{gitleaks_image}} git --no-banner --redact --verbose /work
    docker build --quiet -f docker/typos.Dockerfile -t hushscript-sdk-conformance-typos:local docker
    run hushscript-sdk-conformance-typos:local --config _typos.toml README.md SECURITY.md docs mock scenarios justfile compose.yaml Dockerfile docker eslint.config.js package.json

# build the mock image, start it, and probe it the way an SDK repo would
image-check:
    #!/usr/bin/env bash
    set -euo pipefail
    docker build --quiet -t hushscript-sdk-conformance-mock:ci .
    cid="$(docker run -d --rm --init --label sdk.test=1 --cap-drop ALL --read-only --security-opt no-new-privileges \
      --memory 512m --pids-limit 128 --tmpfs /tmp hushscript-sdk-conformance-mock:ci)"
    trap 'docker stop -t 2 "$cid" >/dev/null 2>&1 || true' EXIT
    healthy=""
    for _ in $(seq 1 30); do
      healthy="$(docker ps --quiet --filter "id=$cid" --filter health=healthy)"
      [ -n "$healthy" ] && break
      sleep 1
    done
    test -n "$healthy" || { echo "mock image never became healthy" >&2; docker logs "$cid" >&2; exit 1; }
    test "$(docker exec "$cid" id -u)" = 10001
    docker exec "$cid" node --input-type=module -e "
      const get = async (p) => (await fetch('http://127.0.0.1:4010' + p)).json();
      const { scenarios } = await get('/__scenarios');
      if (scenarios.length !== 34) throw new Error('scenarios: ' + scenarios.length);
      const durations = await get('/__files/fixtures/media/durations.json');
      if (Object.keys(durations).length !== 20) throw new Error('durations');
    "

# lint, mock self-tests and the image check
ci node="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{node}}" ]; then versions="{{node}}"; else versions="24 26"; fi
    for v in $versions; do
      just lint "$v"
      just test "$v"
    done
    just image-check
