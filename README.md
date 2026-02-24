# Agent Hub

Provider-agnostic multi-agent debate coding MVP for VS Code.

## Structure

- `shared`: contracts and Zod schemas
- `orchestrator`: local API, engine, adapters, SQLite event log
- `vscode-extension`: VS Code commands and debate-log panel
- `data`: SQLite schema

## Features

- N-agent debate loop per stage (`discover -> plan -> patch -> verify -> finalize`)
- Consensus modes: `unanimous`, `quorum`, `judge`
- Hard budget guard (model calls per stage/task + estimated USD cap)
- Test integrity guard (default blocks `**/*.test.*`, `**/__tests__/**`)
- Patch safety guard (protected paths and workspace escape block)
- Verification gate with allowlist commands and automatic retries

## API

- `POST /tasks`
- `GET /tasks/:taskId`
- `POST /tasks/:taskId/decision`
- `GET /events/:taskId` (SSE)
- `GET /health`

## VS Code Commands

- `multiAgent.openStudio`
- `multiAgent.startTask`
- `multiAgent.approvePatch`
- `multiAgent.rejectPatch`
- `multiAgent.retryStep`
- `multiAgent.showDebateLog`

## Quick Start

1. Install deps:

```bash
cd agent-hub
npm install
```

2. Copy `.env.example` to `.env` and fill keys.

3. Run migration and orchestrator:

```bash
npm run migrate -w orchestrator
npm run dev:orchestrator
```

4. Build extension:

```bash
npm run build:extension
```

5. In VS Code extension host, run command `Multi-Agent: Open Studio`.

## One-Click Install (VS Code Installed Extension)

If you want this extension installed like a normal VS Code plugin (not F5 extension host):

1. Double-click:
- `install-extension.bat`

2. Or run command:

```bash
npm run install:extension
```

This will:
- build extension
- package `.vsix`
- install to VS Code via `code --install-extension`

After completion, restart VS Code and run command palette:
- `Multi-Agent: Open Studio`

Or click the left Activity Bar icon:
- `Multi-Agent` -> click `Open Studio`
- Studio left pane: type goal like chat and click `Send`
- Studio right pane: watch live debate + event log
- Final decision is posted back into left chat and recorded in right event log
- `Multi-Agent` -> `API Settings` card -> paste keys (`OpenAI`, `Anthropic`, `Gemini`)
- Optional: set `Writer Agent ID` (for example `driver-openai`) to force patch author selection
- `Debate & Budget Settings` lets you set rounds/retries/consensus/cost limits (`?` popup help)
- Click `Save API Keys`

## Notes

- If no provider keys are configured, use `mock` agents in `AGENT_HUB_AGENTS_JSON`.
- `Writer Agent ID` can also be preconfigured with `AGENT_HUB_DRIVER_AGENT_ID`.
- Debate final round applies `critical bugs only` behavior.
- `unifiedDiff` is stored for audit; actual edits apply through edit operations with fuzzy replace fallback.
