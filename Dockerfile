FROM docker/sandbox-templates:shell-docker

ARG PI_AGENT_VERSION=0.84.2

RUN npm install -g --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_AGENT_VERSION}" \
    && test "$(pi --version)" = "$PI_AGENT_VERSION"

COPY --chown=1000:1000 extensions/ /opt/sbx-kit-pi/extensions/

RUN chmod 0644 /opt/sbx-kit-pi/extensions/agents-postprocessor.ts /opt/sbx-kit-pi/extensions/agents-classifier-output.ts
