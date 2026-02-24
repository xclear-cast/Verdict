# Multi-Agent Debate

Provider-agnostic multi-agent debate coding assistant for VS Code.

## Commands

- `Multi-Agent: Open Studio`
- `Multi-Agent: Start Task`
- `Multi-Agent: Approve Patch`
- `Multi-Agent: Reject Patch`
- `Multi-Agent: Retry Step`
- `Multi-Agent: Show Debate Log`

## Requirement

- Run local orchestrator at `http://127.0.0.1:3939`

## Click Workflow

- Click left Activity Bar icon: `Multi-Agent`
- Click `Open Studio` for split UI:
  - left: chat-style goal input + final decision messages
  - right: live debate turns + event log
- Sidebar is minimal: open Studio and manage API/Writer settings
- In `API Settings`, paste keys (`OpenAI`, `Anthropic`, `Gemini`)
- Optional: set `Writer Agent ID` to choose the patch-writing agent explicitly
- `Debate & Budget Settings` lets you set rounds/retries/consensus/cost limits with `?` popup help
- Click `Save API Keys`
