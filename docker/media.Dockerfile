FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

# jq only reshapes JSON; ffmpeg, which decides the fixture bytes, is the pinned package.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin media

USER 10001
WORKDIR /work
