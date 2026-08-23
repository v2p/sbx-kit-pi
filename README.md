# Pi kit for ChatGPT Plus

This Docker Sandbox kit runs [Pi](https://github.com/earendil-works/pi) with its
`openai-codex` provider, which uses a personal ChatGPT Plus or Pro subscription
through OpenAI OAuth. It does not use an OpenAI API key or API billing.

## Prerequisites

- Docker Sandboxes with `sbx` and schema v2 OAuth credential-file support
- A ChatGPT Plus or Pro subscription

## Validate and run

```console
sbx kit validate .
sbx run --kit . pi-chatgpt-plus
```

On the first run:

1. Approve the `openai-codex` OAuth credential binding when `sbx` prompts.
2. In Pi, enter `/login openai-codex`.
3. Select **Device code login (headless)** and complete the displayed OpenAI
   sign-in flow with the ChatGPT account that owns the subscription.
4. Use `/model` if you want to choose a different Codex model.

Pi stores sessions and settings under `~/.pi/agent/`. Docker's OAuth binding
captures refreshed credentials and can render `auth.json` again when the
sandbox is recreated.

## Why OAuth passthrough is enabled

Docker normally masks OAuth tokens inside a sandbox. Pi's ChatGPT provider must
decode the ChatGPT account ID from the real OAuth access-token JWT before it can
call the Codex backend, so this kit sets `passthrough: true`. Consequently, the
OAuth access and refresh tokens are present inside the sandbox in
`~/.pi/agent/auth.json` (mode `0600`). Keep the sandbox and its filesystem
private, and do not copy or share that file.

The network allowlist is limited to npm installation, Pi's model catalog,
OpenAI authentication, and the ChatGPT Codex backend. Pi's version check and
install telemetry are disabled.

## Sign out

Run `/logout` inside Pi to remove its local credential. If you also want to
remove the host-side credential/binding retained by Docker Sandboxes, inspect
and remove the corresponding `openai-codex` entry with the `sbx secret` and
credential-binding commands supported by your installed `sbx` version.
