SHELL := /bin/bash
.DEFAULT_GOAL := help

PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
COMMAND ?= sbx-pi
ARGS ?=
REGISTRY ?= docker.io
DOCKERHUB_USERNAME ?= vposvistelik
IMAGE_NAME ?= sbx-kit-pi
KIT_VERSION := $(shell node -p "require('./package.json').version")
IMAGE ?= $(REGISTRY)/$(DOCKERHUB_USERNAME)/$(IMAGE_NAME):$(KIT_VERSION)
PI_AGENT_VERSION := $(shell grep -E '^ARG PI_AGENT_VERSION=' Dockerfile | head -1 | cut -d= -f2)

.PHONY: help docker-image ensure-docker-image smoke-docker-image publish validate test audit check run attach resume continue install uninstall

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make <target> [ARGS=\"...\"]\n\n" } /^[a-zA-Z_-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

docker-image: ## Build the sandbox image with Pi and bundled extensions
	docker build --build-arg PI_AGENT_VERSION=$(PI_AGENT_VERSION) -t "$(IMAGE)" .

ensure-docker-image: ## Build the local sandbox image only when missing
	@if ! docker image inspect "$(IMAGE)" >/dev/null 2>&1; then \
		$(MAKE) docker-image; \
	fi

smoke-docker-image: ensure-docker-image ## Verify Pi and bundled extensions in the local image
	docker run --rm --entrypoint sh "$(IMAGE)" -c 'test "$$(pi --version)" = "$(PI_AGENT_VERSION)" && test -r /opt/sbx-kit-pi/extensions/agents-postprocessor.ts && test -r /opt/sbx-kit-pi/extensions/agents-classifier-output.ts'

publish: docker-image smoke-docker-image ## Build, verify, and push the versioned image
	docker push "$(IMAGE)"

validate: smoke-docker-image ## Validate the Docker Sandbox kit
	sbx kit validate .

test: ## Run static tests
	npm test

audit: ## Audit development dependencies
	npm run audit

check: ## Install locked dependencies, audit, test, and validate when sbx is available
	./scripts/check

run: ## Create/run the project sandbox; pass Pi arguments with ARGS="..."
	./scripts/run $(ARGS)

attach: ## Attach to the existing project sandbox
	./scripts/run --attach $(ARGS)

resume: ## Attach and open Pi's session selector
	./scripts/run --attach --resume $(ARGS)

continue: ## Attach and continue the latest Pi session
	./scripts/run --attach --continue $(ARGS)

install: ## Install a global user command at $(BINDIR)/$(COMMAND)
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
