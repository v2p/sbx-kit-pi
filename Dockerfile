# Distro Node builds can omit TypeScript support even at the required version.
ARG NODE_VERSION=22.23.4
FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM docker/sandbox-templates:shell-docker-0.10.0
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN node -e 'if (process.features.typescript !== "strip") process.exit(1)'

ARG PI_AGENT_VERSION=1.4.0

ENV PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0
ENTRYPOINT ["/opt/sbx-kit-pi/scripts/container-entrypoint"]
CMD []

COPY --chown=1000:1000 runtime/package.json runtime/package-lock.json /opt/sbx-kit-pi/runtime/
# The locked project install applies the runtime manifest's security overrides.
# Use modular JS so bundled copies cannot bypass them.
RUN npm ci --prefix /opt/sbx-kit-pi/runtime --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm audit --prefix /opt/sbx-kit-pi/runtime --omit=dev --audit-level=moderate \
    && node -e 'const fs = require("node:fs"); const file = "/opt/sbx-kit-pi/runtime/node_modules/@earendil-works/pi-coding-agent/package.json"; const pkg = JSON.parse(fs.readFileSync(file)); pkg.bin.pi = "dist/cli.js"; pkg.exports["./rpc-entry"].import = "./dist/rpc-entry.js"; fs.writeFileSync(file, JSON.stringify(pkg, null, 2));' \
    && rm -rf /opt/sbx-kit-pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle \
    && ln -sfn ../@earendil-works/pi-coding-agent/dist/cli.js /opt/sbx-kit-pi/runtime/node_modules/.bin/pi \
    && sudo ln -s /opt/sbx-kit-pi/runtime/node_modules/.bin/pi /usr/local/bin/pi \
    && test "$(pi --version)" = "$PI_AGENT_VERSION" \
    && npm cache clean --force

COPY --chown=1000:1000 extensions/ /opt/sbx-kit-pi/extensions/
COPY --chown=1000:1000 scripts/container-entrypoint scripts/import-codex-auth.mts scripts/host-rpc-protocol.mts scripts/runtime-validation.mts scripts/node-environment scripts/check-pi-runtime.mts /opt/sbx-kit-pi/scripts/

# Applies to Pi and subsequent Bash tool calls, preserving caller NODE_OPTIONS.
RUN printf '\n. /opt/sbx-kit-pi/scripts/node-environment\n' | sudo tee -a /etc/sandbox-persistent.sh >/dev/null

RUN chmod 0644 /opt/sbx-kit-pi/scripts/node-environment \
        /opt/sbx-kit-pi/extensions/agents-postprocessor.ts \
        /opt/sbx-kit-pi/extensions/agents-classifier-output.ts \
        /opt/sbx-kit-pi/extensions/host-rpc.ts \
        /opt/sbx-kit-pi/extensions/token-usage.ts \
    && chmod 0755 /opt/sbx-kit-pi/scripts/container-entrypoint /opt/sbx-kit-pi/scripts/import-codex-auth.mts
