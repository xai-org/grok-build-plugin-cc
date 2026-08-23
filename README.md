# Grok Build ↔ Claude Code Bridge

## Install (SHA-256)

Pin GitHub Release **v0.6.0** and verify `SHA256SUMS`. Website `install.sh` / `install.ps1` abort on mismatch.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/tag/v0.6.0
https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/PINNED-INSTALL.md

```
96cef605d3e030ccef99d27ea6240e0d3b668dd045e6b5b9e585c9fd03c6ef23  gbr-agent-darwin-amd64
de7e065ef2cf6877b3b2cd04679a67b627f876337f529247e236204543e4062c  gbr-agent-darwin-arm64
a50a5c41993e6531a3b477eb409ccc845212bf541384dc803061c80657f86719  gbr-agent-linux-amd64
5bfd22c7110234942c4c02ff8154b836d0af45a9422c178a4f52010187d40061  gbr-agent-linux-arm64
f773b89fd31310172b756e0593e0f3b2382b0a3440af2a7d0a8b3073b0c23e27  gbr-agent-windows-amd64.exe
8fb9efcbc7e2ac91c11964944bf0f45e31bb23f4356d9dcb4b305d7cb9b0fe8c  gbr-agent-windows-arm64.exe
```

```bash
VER=v0.6.0
BASE=https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/download/$VER
# swap darwin-arm64 for your OS/arch
curl -fsSL -o gbr-agent-darwin-arm64 "$BASE/gbr-agent-darwin-arm64"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
shasum -a 256 -c SHA256SUMS --ignore-missing
gbr-agent pair && gbr-agent run
```


Bridge [Grok Build](https://x.ai) into Claude Code for review, critique, delegation, and session import.

This repository is a Claude Code marketplace plugin that shells out to the real `grok` CLI. Run status, results, and stop are owned by the plugin (PID + log files). There is no app-server broker.

## Requirements

- Node.js `>= 18.18`
- Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`
- A logged-in Grok CLI session (`grok models` succeeds)

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add xai-org/grok-build-plugin-cc
```

Install the plugin:

```bash
/plugin install grok-build@xai-grok-build
```

Reload plugins:

```bash
/reload-plugins
```

### Local install (from a clone)

From this repository root (path must be absolute):

```bash
# Resolve an absolute path to this clone, then add it as a local marketplace
claude plugin marketplace add "$(pwd)"
# example: claude plugin marketplace add /absolute/path/to/grok-build-plugin-cc

# Install the plugin from that marketplace
claude plugin install grok-build@xai-grok-build
```

Or, when Claude Code is already open, use `/plugin` and add the local marketplace path, then install `grok-build@xai-grok-build`.

## Check readiness

```text
/grok-build:check
```

Ready means: Node is available, `grok` is available, and soft auth via `grok models` succeeds.

## Commands

### `/grok-build:check`

Probe Node + Grok CLI availability and authentication.

### `/grok-build:review`

Read-only review of local git state:

```text
/grok-build:review --wait
/grok-build:review --background --scope working-tree
/grok-build:review --base main
/grok-build:review --wait --model grok-build --effort high
```

Runs:

```bash
grok -p <prompt> --agent explore --permission-mode plan --sandbox read-only --cwd <ws> --output-format plain
```

Optional: pass `--model` / `--effort` (`low`|`medium`|`high`). If omitted, Grok chooses defaults.

### `/grok-build:critique`

Same target selection as review, with a design/risk critique prompt and structured JSON output when possible:

```text
/grok-build:critique --wait
/grok-build:critique --base main challenge whether this was the right caching and retry design
/grok-build:critique --wait --model grok-build --effort high focus on failure modes
```

Optional: same `--model` / `--effort` flags as review.

### `/grok-build:delegate`

Delegate investigation or implementation to Grok via the `grok-build:grok-delegate` subagent:

```text
/grok-build:delegate investigate the flaky test in auth
/grok-build:delegate --resume apply the top fix
/grok-build:delegate --model grok-build --effort high fix the race
```

Write policy layering:

| Layer | Default |
| --- | --- |
| Bridge `run` CLI | **Read-only** (`--permission-mode plan` + `--sandbox read-only`) unless you pass `--write` |
| Delegate agent / skill | Adds `--write` by policy (write-capable delegate) unless the user asks for read-only |

- Direct `node …/grok-bridge.mjs run "…"` is therefore read-only unless `--write` is passed.
- `--resume` / `--resume-last` continues the last stored Grok session id via `grok -r <id>`.
- Prefer bridge `--background` for long work so runs record both `bridgePid` (Node worker) and `agentPid` (grok child).
- `/grok-build:stop` terminates **both** process trees when present (agent then bridge/worker).
- If you do not pass `--model` or `--effort`, Grok chooses its own defaults.

### `/grok-build:import`

Import the current Claude transcript into Grok:

```text
/grok-build:import
/grok-build:import --source ~/.claude/projects/.../session.jsonl
```

Uses `grok import` and prints a resume hint: `grok -r <id>`.

### `/grok-build:runs`

List active and recent plugin-owned runs:

```text
/grok-build:runs
/grok-build:runs <run-id> --wait
```

### `/grok-build:show`

Show stored output for a finished run:

```text
/grok-build:show
/grok-build:show <run-id>
```

### `/grok-build:stop`

Stop an active run by terminating tracked process trees:

```text
/grok-build:stop
/grok-build:stop <run-id>
```

Kills every distinct pid among `agentPid` (detached grok child) and `bridgePid` / legacy `companionPid` / legacy `pid` (bridge or run-worker). Terminal status is claimed under a locked CAS so a finishing worker cannot overwrite `cancelled` with `completed`.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Optional override for the `grok` executable |
| `GROK_CC_SESSION_ID` | Claude session id (set by SessionStart hook) |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path (set by SessionStart hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; state lives under `.../state` |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |

State fallback when `CLAUDE_PLUGIN_DATA` is unset: `$TMPDIR/grok-cc-runs`.

## Development

```bash
npm test
```

Tests use Node's built-in test runner and a fake `grok` binary on `PATH`. Runtime code uses Node stdlib only.

Version: `0.2.0`.

## Spectator phone (Build Remote Agent)

This plugin stays the Claude Code ↔ Grok CLI bridge. To spectate the **desktop** Claude Code / Grok Build session from a phone, pair [Build Remote Agent](https://grokbuildremote.com/) with `gbr-agent` (`gbr/1`). See [docs/gbr.md](docs/gbr.md). Independent product — not affiliated with xAI or SpaceX.


Attach only `http://127.0.0.1:8788` or stdio `gbr-mcp`. Never commit mailbox keys.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## What the phone sees

**Terminal windows** on this PC (machine-wide mailbox). Not headless OpenCode / CodeNomad sidecar / Electron. `:8788` in a sidecar is Bot API JSON, not a transcript.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/WHAT-THE-PHONE-SEES.md
https://grokbuildremote.com/integrations.html
