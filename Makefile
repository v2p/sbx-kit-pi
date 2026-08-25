SHELL := /bin/bash
.DEFAULT_GOAL := help

PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
COMMAND ?= sbx-pi
ARGS ?=

.PHONY: help validate test audit check run attach resume continue install uninstall

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make <target> [ARGS=\"...\"]\n\n" } /^[a-zA-Z_-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

validate: ## Validate the Docker Sandbox kit
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
