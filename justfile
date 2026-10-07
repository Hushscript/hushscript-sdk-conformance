# Every recipe runs in a container; nothing here touches host toolchains.
set shell := ["bash", "-euo", "pipefail", "-c"]

export HOST_UID := `id -u`
export HOST_GID := `id -g`

node22_image := "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
node24_image := "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
node_image := node22_image
hadolint_image := "hadolint/hadolint:v2.14.0@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e"
actionlint_image := "rhysd/actionlint:1.7.8@sha256:96d4a8c87dbbfb3bdd324f8fdc285fc3df5261e2decc619a4dd7e8ee52bbfd46"
zizmor_image := "ghcr.io/zizmorcore/zizmor:1.16.0@sha256:a6460f1b6fe3dc08e588d314e73563bdd218ee30c995a4be5e9ee5bd300391ce"
shellcheck_image := "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
gitleaks_image := "ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854"
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

# every static check: types, eslint, prettier, hadolint, actionlint, zizmor, shellcheck, gitleaks, typos
lint node="22":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{node}}" in 22) image="{{node22_image}}" ;; 24) image="{{node24_image}}" ;; *) echo "node must be 22 or 24" >&2; exit 2 ;; esac
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
      if (scenarios.length !== 31) throw new Error('scenarios: ' + scenarios.length);
      const durations = await get('/__files/fixtures/media/durations.json');
      if (Object.keys(durations).length !== 20) throw new Error('durations');
    "

# lint, mock self-tests and the image check
ci node="22":
    just lint {{node}}
    just test {{node}}
    just image-check
