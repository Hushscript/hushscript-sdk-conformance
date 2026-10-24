FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# jq only reshapes JSON; ffmpeg, which decides the fixture bytes, is the pinned package.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin media

USER 10001
WORKDIR /work
