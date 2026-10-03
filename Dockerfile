FROM docker/sandbox-templates:shell-docker-0.5.0

ARG PI_AGENT_VERSION=1.0.1

RUN npm install -g --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_AGENT_VERSION}" \
    && test "$(pi --version)" = "$PI_AGENT_VERSION" \
    && npm cache clean --force

COPY --chown=1000:1000 extensions/ /opt/sbx-kit-pi/extensions/
COPY --chown=1000:1000 scripts/container-entrypoint scripts/import-codex-auth.mjs /opt/sbx-kit-pi/scripts/

RUN chmod 0644 /opt/sbx-kit-pi/extensions/agents-postprocessor.ts \
        /opt/sbx-kit-pi/extensions/agents-classifier-output.ts \
        /opt/sbx-kit-pi/extensions/linux-notifications.ts \
        /opt/sbx-kit-pi/extensions/token-usage.ts \
    && chmod 0755 /opt/sbx-kit-pi/scripts/container-entrypoint /opt/sbx-kit-pi/scripts/import-codex-auth.mjs
