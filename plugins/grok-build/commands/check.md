---
description: Check whether the local Grok Build CLI is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" check --json $ARGUMENTS
```

If the result says Grok is unavailable:
- Do not invent an install path. Tell the user to install the Grok Build CLI and ensure `grok` is on PATH (or set `GROK_BINARY`).
- Then rerun `/grok-build:check` after they install it.

If Grok is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If Grok is installed but not authenticated, preserve the guidance to authenticate (for example complete login via interactive `grok`, then verify that the first line of `grok models` no longer reads `You are not authenticated.`; it exits 0 either way).
