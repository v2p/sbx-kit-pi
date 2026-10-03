SHELL := /bin/bash
.DEFAULT_GOAL := help

PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
COMMAND ?= sbx-pi
REGISTRY ?= docker.io
DOCKERHUB_USERNAME ?= vposvistelik
IMAGE_NAME ?= sbx-kit-pi
KIT_VERSION := $(shell node -p "require('./package.json').version")
IMAGE ?= $(REGISTRY)/$(DOCKERHUB_USERNAME)/$(IMAGE_NAME):$(KIT_VERSION)
PI_AGENT_VERSION := $(shell grep -E '^ARG PI_AGENT_VERSION=' Dockerfile | head -1 | cut -d= -f2)

.PHONY: help image publish install uninstall

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make <target>\n\n" } /^[a-zA-Z_-]+:.*## / { printf "  %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

image: ## Build and smoke-test the sandbox image
	docker build --build-arg PI_AGENT_VERSION=$(PI_AGENT_VERSION) -t "$(IMAGE)" .
	docker run --rm --entrypoint sh "$(IMAGE)" -c 'test "$$(pi --version)" = "$(PI_AGENT_VERSION)" && test -r /opt/sbx-kit-pi/extensions/agents-postprocessor.ts && test -r /opt/sbx-kit-pi/extensions/agents-classifier-output.ts && test -r /opt/sbx-kit-pi/extensions/linux-notifications.ts && test -r /opt/sbx-kit-pi/extensions/token-usage.ts && test -x /opt/sbx-kit-pi/scripts/container-entrypoint && test -x /opt/sbx-kit-pi/scripts/import-codex-auth.mjs && pi --offline --no-extensions --extension /opt/sbx-kit-pi/extensions/agents-postprocessor.ts --extension /opt/sbx-kit-pi/extensions/linux-notifications.ts --extension /opt/sbx-kit-pi/extensions/token-usage.ts --list-models openai-codex >/dev/null'

publish: image ## Build, verify, and push the versioned image
	docker push "$(IMAGE)"

install: ## Install a global user command at $(BINDIR)/$(COMMAND)
	@node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1); require("smol-toml")' >/dev/null 2>&1 || { printf 'Install Node.js 22.19+ and run npm ci --omit=dev --ignore-scripts before make install\n' >&2; exit 1; }
	@mkdir -p "$(BINDIR)"
	@ln -sfn "$(CURDIR)/scripts/run" "$(BINDIR)/$(COMMAND)"
	@printf 'Installed %s -> %s\n' "$(BINDIR)/$(COMMAND)" "$(CURDIR)/scripts/run"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; *) printf 'Add %s to PATH, for example in ~/.profile:\n  export PATH="%s:$$PATH"\n' "$(BINDIR)" "$(BINDIR)" ;; esac

uninstall: ## Remove the user command installed by this checkout
	@if [[ -L "$(BINDIR)/$(COMMAND)" && "$$(readlink -f "$(BINDIR)/$(COMMAND)")" == "$(CURDIR)/scripts/run" ]]; then \
		rm "$(BINDIR)/$(COMMAND)"; \
		printf 'Removed %s\n' "$(BINDIR)/$(COMMAND)"; \
	else \
		printf 'Refusing to remove %s: it is not a symlink to this checkout\n' "$(BINDIR)/$(COMMAND)" >&2; \
		exit 1; \
	fi
