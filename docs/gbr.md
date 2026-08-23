# Build Remote Agent — phone pairing for Claude Code ↔ Grok Build

This plugin still shells out to the `grok` CLI from Claude Code. **Build Remote Agent** is a separate pairing device: a phone spectates (and can inject/veto) that **desktop** Claude Code / Grok Build session through free MIT `gbr-agent`.

It does not replace `/grok-build:*` commands, the marketplace plugin, or the grok CLI.

## Install + pair

```bash
# macOS / Linux
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version          # must print v0.6.0 or newer
gbr-agent pair             # QR in browser + printed 8-char code
gbr-agent run              # leave running
```

```powershell
# Windows
irm https://grokbuildremote.com/install.ps1 | iex
gbr-agent version
gbr-agent pair
gbr-agent run
```

Phone: open [Build Remote Agent](https://grokbuildremote.com/) → **Scan QR from computer** (or type the 8-char code). Sessions appear in the app. **Unpair** in Settings before changing PCs. Force-close is not enough.

## Attach

After `gbr-agent run`:

| How | Where |
|-----|--------|
| Bot API | `http://127.0.0.1:8788` |
| MCP stdio | `node …/GrokBuildRemote-Agents/mcp/gbr-mcp/bin/gbr-mcp.js` |

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

Phone is spectator + veto, not orchestrator. Do not commit mailbox keys. Phone **Settings → Bot API** is the only place a relay key is copied.

MCP clone:

```bash
git clone https://github.com/LinespottingOrg/GrokBuildRemote-Agents.git
cd GrokBuildRemote-Agents/mcp/gbr-mcp && npm install
node bin/gbr-mcp.js --diagnose
```

Protocol `gbr/1`. Independent product by Linespotting AB. Not affiliated with xAI or SpaceX.

Docs: https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/BOT-API.md
Website: https://grokbuildremote.com/

