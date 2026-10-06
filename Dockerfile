# The mock API server every SDK repo's compose file builds.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production
WORKDIR /srv/conformance

COPY --chown=10001:10001 mock/*.mjs mock/
COPY --chown=10001:10001 mock/routes/*.mjs mock/routes/
COPY --chown=10001:10001 scenarios scenarios
COPY --chown=10001:10001 fixtures fixtures
COPY --chown=10001:10001 hints.json hints.json

USER 10001:10001
EXPOSE 4010

HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=15 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4010/__health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "mock/server.mjs", "--port", "4010", "--host", "0.0.0.0"]
