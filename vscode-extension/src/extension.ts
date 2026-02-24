import * as vscode from "vscode";
import path from "node:path";

type DecisionAction = "approve_patch" | "reject_patch" | "retry_step";
type SidebarAction =
  | "openStudio"
  | "refreshState"
  | "saveApiSettings";

interface RuntimeSettingsSummary {
  openAIApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  geminiApiKeyConfigured: boolean;
  agentsJsonConfigured: boolean;
  driverAgentId?: string;
  maxDebateRounds?: number;
  maxRetriesPerStage?: number;
  consensusMode?: "unanimous" | "quorum" | "judge";
  quorumRatio?: number;
  criticalOnlyInFinalRound?: boolean;
  maxStageExecutions?: number;
  maxModelCallsPerStage?: number;
  maxModelCallsPerTask?: number;
  maxCostUsd?: number;
  updatedAt?: string;
}

interface SidebarMessage {
  command?: SidebarAction;
  openAIApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  driverAgentId?: string;
  maxDebateRounds?: number;
  maxRetriesPerStage?: number;
  consensusMode?: "unanimous" | "quorum" | "judge";
  quorumRatio?: number;
  criticalOnlyInFinalRound?: boolean;
  maxStageExecutions?: number;
  maxModelCallsPerStage?: number;
  maxModelCallsPerTask?: number;
  maxCostUsd?: number;
}

interface StudioMessage {
  command?: "startTask" | "decision" | "rememberTask" | "openDebateLog";
  userGoal?: string;
  taskId?: string;
  action?: DecisionAction;
  note?: string;
}

interface TaskBundle {
  task: {
    id: string;
    status: string;
    currentStage: string;
    lastError?: string;
  };
  turns: Array<{
    stage: string;
    round: number;
    attempt: number;
    agentId: string;
    provider: string;
    verdict: string;
    message: string;
    timestamp: string;
  }>;
  latestVerification?: {
    passed: boolean;
    failures: string[];
    commands: string[];
  };
  latestPatch?: {
    summary: string;
    confidence: number;
    touchedFiles: string[];
  };
}

const LAST_TASK_KEY = "multiAgent.lastTaskId";
const EVENT_NAMES = [
  "task_started",
  "stage_started",
  "turn_recorded",
  "stage_completed",
  "verification_completed",
  "needs_human_decision",
  "task_completed",
  "task_failed",
  "task_stopped_budget",
  "decision_applied"
] as const;

class MultiAgentSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "multiAgent.sidebar";
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.renderSidebarHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message: SidebarMessage) => {
        const command = message?.command;
        if (!command) return;

        if (command === "refreshState") {
          await this.postState();
          return;
        }

        if (command === "saveApiSettings") {
          try {
            await fetchJson<RuntimeSettingsSummary>(`${getOrchestratorUrl()}/settings/runtime`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                openAIApiKey: typeof message.openAIApiKey === "string" ? message.openAIApiKey : undefined,
                anthropicApiKey:
                  typeof message.anthropicApiKey === "string" ? message.anthropicApiKey : undefined,
                geminiApiKey: typeof message.geminiApiKey === "string" ? message.geminiApiKey : undefined,
                driverAgentId: typeof message.driverAgentId === "string" ? message.driverAgentId : undefined,
                maxDebateRounds: typeof message.maxDebateRounds === "number" ? message.maxDebateRounds : undefined,
                maxRetriesPerStage:
                  typeof message.maxRetriesPerStage === "number" ? message.maxRetriesPerStage : undefined,
                consensusMode: message.consensusMode,
                quorumRatio: typeof message.quorumRatio === "number" ? message.quorumRatio : undefined,
                criticalOnlyInFinalRound:
                  typeof message.criticalOnlyInFinalRound === "boolean" ? message.criticalOnlyInFinalRound : undefined,
                maxStageExecutions:
                  typeof message.maxStageExecutions === "number" ? message.maxStageExecutions : undefined,
                maxModelCallsPerStage:
                  typeof message.maxModelCallsPerStage === "number" ? message.maxModelCallsPerStage : undefined,
                maxModelCallsPerTask:
                  typeof message.maxModelCallsPerTask === "number" ? message.maxModelCallsPerTask : undefined,
                maxCostUsd: typeof message.maxCostUsd === "number" ? message.maxCostUsd : undefined
              })
            });
            this.postToast("API keys saved");
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.postToast(`Save failed: ${text}`);
          }
          await this.postState();
          return;
        }

        if (command === "openStudio") {
          try {
            await vscode.commands.executeCommand("multiAgent.openStudio");
            this.postToast("Done");
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.postToast(`Error: ${text}`);
          }
          await this.postState();
        }
      },
      undefined,
      this.context.subscriptions
    );

    void this.postState();
  }

  refresh(): void {
    void this.postState();
  }

  private postToast(message: string): void {
    this.view?.webview.postMessage({
      type: "toast",
      message
    });
  }

  private async postState(): Promise<void> {
    const runtime = await fetchRuntimeSettings();

    this.view?.webview.postMessage({
      type: "state",
      taskId: this.context.globalState.get<string>(LAST_TASK_KEY) ?? "",
      orchestratorUrl: getOrchestratorUrl(),
      runtime
    });
  }

  private renderSidebarHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <style>
      body { font-family: Segoe UI, sans-serif; padding: 12px; color: var(--vscode-foreground); }
      .card { border: 1px solid var(--vscode-editorWidget-border); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
      .title { font-weight: 700; margin-bottom: 8px; }
      .meta { font-size: 12px; opacity: 0.9; margin-bottom: 4px; word-break: break-all; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .full { grid-column: span 2; }
      .field { margin-top: 8px; }
      .field-label { font-size: 12px; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .check-field {
        font-size: 12px;
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
      }
      input:not([type="checkbox"]), select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 7px 8px;
        border-radius: 7px;
        font-size: 12px;
      }
      input:not([type="checkbox"]) { margin-top: 6px; }
      .check-field input[type="checkbox"] {
        width: auto;
        min-width: auto;
        margin: 0;
        padding: 0;
        align-self: center;
      }
      .check-field span {
        margin: 0;
        line-height: 1.35;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 7px 8px;
        border-radius: 7px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      .help-btn {
        width: 18px;
        height: 18px;
        min-width: 18px;
        border-radius: 999px;
        padding: 0;
        font-size: 11px;
        line-height: 1;
      }
      #status { font-size: 12px; margin-top: 8px; min-height: 16px; opacity: 0.9; }
      .help-modal {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
      }
      .help-modal.hidden { display: none; }
      .help-card {
        width: min(420px, 92vw);
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 10px;
        background: var(--vscode-editor-background);
        padding: 12px;
      }
      .help-title { font-weight: 700; margin-bottom: 8px; }
      .help-body { font-size: 12px; line-height: 1.45; white-space: pre-wrap; margin-bottom: 10px; opacity: 0.95; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">Multi-Agent</div>
      <div class="meta">Task: <span id="taskId">-</span></div>
      <div class="meta">API: <span id="apiUrl">-</span></div>
      <div class="meta">OpenAI Key: <span id="openAIStatus">not set</span></div>
      <div class="meta">Anthropic Key: <span id="anthropicStatus">not set</span></div>
      <div class="meta">Gemini Key: <span id="geminiStatus">not set</span></div>
      <div class="meta">Writer Agent: <span id="driverStatus">auto</span></div>
      <div class="meta">Debate Policy: <span id="debateStatus">default</span></div>
      <div class="meta">Budget Limits: <span id="budgetStatus">default</span></div>
      <div id="status">Ready</div>
    </div>

    <div class="card">
      <div class="title">API Settings</div>
      <input id="openAIKeyInput" type="password" placeholder="OpenAI API key (optional)" />
      <input id="anthropicKeyInput" type="password" placeholder="Anthropic API key (optional)" />
      <input id="geminiKeyInput" type="password" placeholder="Google Gemini API key (optional)" />
      <input id="driverIdInput" type="text" placeholder="Writer Agent ID (optional, e.g. coder-openai)" />
      <div class="actions" style="margin-top:8px;">
        <button class="full" data-action="saveApiSettings">Save API Keys</button>
      </div>
    </div>

    <div class="card">
      <div class="title">Debate & Budget Settings</div>
      <div class="field">
        <div class="field-label">Max Debate Rounds <button type="button" class="help-btn" data-help="maxDebateRounds">?</button></div>
        <input id="maxDebateRoundsInput" type="number" min="1" max="5" placeholder="2" />
      </div>
      <div class="field">
        <div class="field-label">Max Retries Per Stage <button type="button" class="help-btn" data-help="maxRetriesPerStage">?</button></div>
        <input id="maxRetriesPerStageInput" type="number" min="0" max="10" placeholder="2" />
      </div>
      <div class="field">
        <div class="field-label">Consensus Mode <button type="button" class="help-btn" data-help="consensusMode">?</button></div>
        <select id="consensusModeInput">
          <option value="">default (unanimous)</option>
          <option value="unanimous">unanimous</option>
          <option value="quorum">quorum</option>
          <option value="judge">judge</option>
        </select>
      </div>
      <div class="field">
        <div class="field-label">Quorum Ratio <button type="button" class="help-btn" data-help="quorumRatio">?</button></div>
        <input id="quorumRatioInput" type="number" min="0.5" max="1" step="0.01" placeholder="1.0" />
      </div>
      <div class="check-field">
        <input id="criticalOnlyInput" type="checkbox" />
        <span>Critical-only review in final round</span>
        <button type="button" class="help-btn" data-help="criticalOnlyInFinalRound">?</button>
      </div>
      <div class="field">
        <div class="field-label">Max Stage Executions <button type="button" class="help-btn" data-help="maxStageExecutions">?</button></div>
        <input id="maxStageExecutionsInput" type="number" min="1" max="20" placeholder="5" />
      </div>
      <div class="field">
        <div class="field-label">Max Model Calls Per Stage <button type="button" class="help-btn" data-help="maxModelCallsPerStage">?</button></div>
        <input id="maxModelCallsPerStageInput" type="number" min="1" max="200" placeholder="4" />
      </div>
      <div class="field">
        <div class="field-label">Max Model Calls Per Task <button type="button" class="help-btn" data-help="maxModelCallsPerTask">?</button></div>
        <input id="maxModelCallsPerTaskInput" type="number" min="1" max="2000" placeholder="40" />
      </div>
      <div class="field">
        <div class="field-label">Max Cost USD <button type="button" class="help-btn" data-help="maxCostUsd">?</button></div>
        <input id="maxCostUsdInput" type="number" min="0.01" max="1000" step="0.01" placeholder="1.00" />
      </div>
      <div class="actions" style="margin-top:8px;">
        <button class="full" data-action="saveApiSettings">Save Debate/Budget</button>
      </div>
    </div>

    <div class="actions">
      <button class="full" data-action="openStudio">Open Studio</button>
      <button class="full" data-action="refreshState">Refresh</button>
    </div>

    <div id="helpModal" class="help-modal hidden">
      <div class="help-card">
        <div id="helpTitle" class="help-title">Help</div>
        <div id="helpBody" class="help-body"></div>
        <div class="actions">
          <button id="helpCloseBtn" class="full" type="button">Close</button>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const taskIdEl = document.getElementById("taskId");
      const apiUrlEl = document.getElementById("apiUrl");
      const openAIStatusEl = document.getElementById("openAIStatus");
      const anthropicStatusEl = document.getElementById("anthropicStatus");
      const geminiStatusEl = document.getElementById("geminiStatus");
      const driverStatusEl = document.getElementById("driverStatus");
      const debateStatusEl = document.getElementById("debateStatus");
      const budgetStatusEl = document.getElementById("budgetStatus");
      const statusEl = document.getElementById("status");
      const openAIKeyInput = document.getElementById("openAIKeyInput");
      const anthropicKeyInput = document.getElementById("anthropicKeyInput");
      const geminiKeyInput = document.getElementById("geminiKeyInput");
      const driverIdInput = document.getElementById("driverIdInput");
      const maxDebateRoundsInput = document.getElementById("maxDebateRoundsInput");
      const maxRetriesPerStageInput = document.getElementById("maxRetriesPerStageInput");
      const consensusModeInput = document.getElementById("consensusModeInput");
      const quorumRatioInput = document.getElementById("quorumRatioInput");
      const criticalOnlyInput = document.getElementById("criticalOnlyInput");
      const maxStageExecutionsInput = document.getElementById("maxStageExecutionsInput");
      const maxModelCallsPerStageInput = document.getElementById("maxModelCallsPerStageInput");
      const maxModelCallsPerTaskInput = document.getElementById("maxModelCallsPerTaskInput");
      const maxCostUsdInput = document.getElementById("maxCostUsdInput");
      const helpModal = document.getElementById("helpModal");
      const helpTitle = document.getElementById("helpTitle");
      const helpBody = document.getElementById("helpBody");
      const helpCloseBtn = document.getElementById("helpCloseBtn");

      const defaults = {
        maxDebateRounds: 2,
        maxRetriesPerStage: 2,
        consensusMode: "unanimous",
        quorumRatio: 1,
        criticalOnlyInFinalRound: true,
        maxStageExecutions: 5,
        maxModelCallsPerStage: 4,
        maxModelCallsPerTask: 40,
        maxCostUsd: 1
      };

      const helpTexts = {
        maxDebateRounds: { title: "Max Debate Rounds", body: "Sets how many rounds agents can debate per stage." },
        maxRetriesPerStage: { title: "Max Retries Per Stage", body: "How many retries are allowed for each stage." },
        consensusMode: { title: "Consensus Mode", body: "unanimous: all approve, quorum: ratio threshold, judge: judge role decides." },
        quorumRatio: { title: "Quorum Ratio", body: "Only used in quorum mode. Example: 0.67 means 67%+ approvals." },
        criticalOnlyInFinalRound: { title: "Critical-only Final Round", body: "Final round focuses on critical issues only." },
        maxStageExecutions: { title: "Max Stage Executions", body: "Maximum stage executions per task." },
        maxModelCallsPerStage: { title: "Max Model Calls Per Stage", body: "Maximum model calls allowed in one stage." },
        maxModelCallsPerTask: { title: "Max Model Calls Per Task", body: "Maximum model calls allowed in one task." },
        maxCostUsd: { title: "Max Cost USD", body: "Estimated per-task cost ceiling; task stops when exceeded." }
      };

      function readOptionalNumber(input) {
        if (!input) return undefined;
        const raw = input.value ? input.value.trim() : "";
        if (!raw) return undefined;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return undefined;
        return parsed;
      }

      function openHelp(key) {
        const entry = helpTexts[key];
        if (!entry || !helpModal || !helpTitle || !helpBody) return;
        helpTitle.textContent = entry.title;
        helpBody.textContent = entry.body;
        helpModal.classList.remove("hidden");
      }

      function closeHelp() {
        if (!helpModal) return;
        helpModal.classList.add("hidden");
      }

      document.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = btn.getAttribute("data-action");
          if (!action) return;
          statusEl.textContent = "Running...";
          if (action === "saveApiSettings") {
            vscode.postMessage({
              command: action,
              openAIApiKey: openAIKeyInput ? openAIKeyInput.value : "",
              anthropicApiKey: anthropicKeyInput ? anthropicKeyInput.value : "",
              geminiApiKey: geminiKeyInput ? geminiKeyInput.value : "",
              driverAgentId: driverIdInput ? driverIdInput.value : "",
              maxDebateRounds: readOptionalNumber(maxDebateRoundsInput),
              maxRetriesPerStage: readOptionalNumber(maxRetriesPerStageInput),
              consensusMode: consensusModeInput && consensusModeInput.value ? consensusModeInput.value : undefined,
              quorumRatio: readOptionalNumber(quorumRatioInput),
              criticalOnlyInFinalRound: criticalOnlyInput ? criticalOnlyInput.checked : undefined,
              maxStageExecutions: readOptionalNumber(maxStageExecutionsInput),
              maxModelCallsPerStage: readOptionalNumber(maxModelCallsPerStageInput),
              maxModelCallsPerTask: readOptionalNumber(maxModelCallsPerTaskInput),
              maxCostUsd: readOptionalNumber(maxCostUsdInput)
            });
            return;
          }
          vscode.postMessage({ command: action });
        });
      });

      document.querySelectorAll("button[data-help]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-help");
          if (!key) return;
          openHelp(key);
        });
      });

      if (helpCloseBtn) {
        helpCloseBtn.addEventListener("click", closeHelp);
      }
      if (helpModal) {
        helpModal.addEventListener("click", (event) => {
          if (event.target === helpModal) {
            closeHelp();
          }
        });
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg?.type === "state") {
          taskIdEl.textContent = msg.taskId || "-";
          apiUrlEl.textContent = msg.orchestratorUrl || "-";
          openAIStatusEl.textContent = msg.runtime?.openAIApiKeyConfigured ? "configured" : "not set";
          anthropicStatusEl.textContent = msg.runtime?.anthropicApiKeyConfigured ? "configured" : "not set";
          geminiStatusEl.textContent = msg.runtime?.geminiApiKeyConfigured ? "configured" : "not set";
          driverStatusEl.textContent = msg.runtime?.driverAgentId || "auto";
          debateStatusEl.textContent =
            "r=" + String(msg.runtime?.maxDebateRounds ?? defaults.maxDebateRounds) +
            ", retry=" + String(msg.runtime?.maxRetriesPerStage ?? defaults.maxRetriesPerStage) +
            ", mode=" + String(msg.runtime?.consensusMode ?? defaults.consensusMode) +
            ", q=" + String(msg.runtime?.quorumRatio ?? defaults.quorumRatio);
          budgetStatusEl.textContent =
            "stageExec=" + String(msg.runtime?.maxStageExecutions ?? defaults.maxStageExecutions) +
            ", stageCalls=" + String(msg.runtime?.maxModelCallsPerStage ?? defaults.maxModelCallsPerStage) +
            ", taskCalls=" + String(msg.runtime?.maxModelCallsPerTask ?? defaults.maxModelCallsPerTask) +
            ", maxCost=$" + String(msg.runtime?.maxCostUsd ?? defaults.maxCostUsd);

          statusEl.textContent = "Ready";
          if (openAIKeyInput) openAIKeyInput.value = "";
          if (anthropicKeyInput) anthropicKeyInput.value = "";
          if (geminiKeyInput) geminiKeyInput.value = "";
          if (driverIdInput) driverIdInput.value = msg.runtime?.driverAgentId || "";

          if (maxDebateRoundsInput) {
            maxDebateRoundsInput.value =
              typeof msg.runtime?.maxDebateRounds === "number" ? String(msg.runtime.maxDebateRounds) : "";
          }
          if (maxRetriesPerStageInput) {
            maxRetriesPerStageInput.value =
              typeof msg.runtime?.maxRetriesPerStage === "number" ? String(msg.runtime.maxRetriesPerStage) : "";
          }
          if (consensusModeInput) {
            consensusModeInput.value = msg.runtime?.consensusMode || "";
          }
          if (quorumRatioInput) {
            quorumRatioInput.value =
              typeof msg.runtime?.quorumRatio === "number" ? String(msg.runtime.quorumRatio) : "";
          }
          if (criticalOnlyInput) {
            criticalOnlyInput.checked =
              typeof msg.runtime?.criticalOnlyInFinalRound === "boolean"
                ? msg.runtime.criticalOnlyInFinalRound
                : defaults.criticalOnlyInFinalRound;
          }
          if (maxStageExecutionsInput) {
            maxStageExecutionsInput.value =
              typeof msg.runtime?.maxStageExecutions === "number" ? String(msg.runtime.maxStageExecutions) : "";
          }
          if (maxModelCallsPerStageInput) {
            maxModelCallsPerStageInput.value =
              typeof msg.runtime?.maxModelCallsPerStage === "number" ? String(msg.runtime.maxModelCallsPerStage) : "";
          }
          if (maxModelCallsPerTaskInput) {
            maxModelCallsPerTaskInput.value =
              typeof msg.runtime?.maxModelCallsPerTask === "number" ? String(msg.runtime.maxModelCallsPerTask) : "";
          }
          if (maxCostUsdInput) {
            maxCostUsdInput.value = typeof msg.runtime?.maxCostUsd === "number" ? String(msg.runtime.maxCostUsd) : "";
          }
        }

        if (msg?.type === "toast") {
          statusEl.textContent = msg.message || "Done";
        }
      });

      vscode.postMessage({ command: "refreshState" });
    </script>
  </body>
</html>`;
  }
}
function getOrchestratorUrl(): string {
  const config = vscode.workspace.getConfiguration("multiAgent");
  return String(config.get("orchestratorUrl", "http://127.0.0.1:3939")).replace(/\/+$/, "");
}

function getConnectOrigin(orchestratorUrl: string): string {
  try {
    return new URL(orchestratorUrl).origin;
  } catch {
    return orchestratorUrl;
  }
}

function toScriptJson<T>(value: T): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 24; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return (await response.json()) as T;
}

async function fetchRuntimeSettings(orchestratorUrl = getOrchestratorUrl()): Promise<RuntimeSettingsSummary> {
  try {
    return await fetchJson<RuntimeSettingsSummary>(`${orchestratorUrl}/settings/runtime`);
  } catch {
    return {
      openAIApiKeyConfigured: false,
      anthropicApiKeyConfigured: false,
      geminiApiKeyConfigured: false,
      agentsJsonConfigured: false
    };
  }
}

function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function resolveWorkspacePath(): Promise<string | undefined> {
  const fromWorkspace = getWorkspacePath();
  if (fromWorkspace) return fromWorkspace;

  const activeEditorPath = vscode.window.activeTextEditor?.document?.uri.fsPath;
  if (activeEditorPath) {
    return path.dirname(activeEditorPath);
  }

  const picked = await vscode.window.showOpenDialog({
    title: "Select workspace folder for Multi-Agent task",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this folder"
  });
  return picked?.[0]?.fsPath;
}

async function resolveTaskId(context: vscode.ExtensionContext): Promise<string | undefined> {
  const remembered = context.globalState.get<string>(LAST_TASK_KEY);
  if (remembered) return remembered;
  const typed = await vscode.window.showInputBox({
    title: "Task ID",
    prompt: "Enter taskId from orchestrator",
    ignoreFocusOut: true
  });
  return typed?.trim() || undefined;
}

function renderDebateHtml(bundle: TaskBundle, orchestratorUrl: string, cspSource: string, nonce: string): string {
  const connectOrigin = getConnectOrigin(orchestratorUrl);
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${connectOrigin};"
    />
    <style>
      body { font-family: Segoe UI, sans-serif; padding: 16px; }
      .summary { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 8px; margin-bottom: 12px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; background: #fafafa; }
      .row { margin: 4px 0; white-space: pre-wrap; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f5f5f5; }
      code { background: #f0f0f0; padding: 2px 4px; }
      #statusBar { margin-bottom: 10px; font-size: 12px; color: #666; }
      #refreshBtn { margin-right: 8px; }
    </style>
  </head>
  <body>
    <h2 id="taskTitle"></h2>
    <div id="statusBar">
      <button id="refreshBtn">Refresh</button>
      <span id="connectionState">connecting...</span>
    </div>
    <div class="summary">
      <div class="card">
        <div class="row"><b>Status:</b> <span id="taskStatus"></span></div>
        <div class="row"><b>Current Stage:</b> <span id="taskStage"></span></div>
        <div class="row"><b>Last Error:</b> <span id="taskError">-</span></div>
      </div>
      <div class="card">
        <div class="row"><b>Verification:</b> <span id="verificationResult">none</span></div>
        <div class="row"><b>Failures:</b> <span id="verificationFailures">-</span></div>
        <div class="row"><b>Commands:</b> <span id="verificationCommands">-</span></div>
      </div>
      <div class="card">
        <div class="row"><b>Latest Patch:</b> <span id="patchSummary">none</span></div>
        <div class="row"><b>Confidence:</b> <span id="patchConfidence">-</span></div>
        <div class="row"><b>Touched:</b> <span id="patchTouched">-</span></div>
      </div>
      <div class="card">
        <div class="row"><b>Turns:</b> <span id="turnCount">0</span></div>
        <div class="row"><b>Updated:</b> <span id="updatedAt">-</span></div>
      </div>
    </div>
    <h3>Debate Turns</h3>
    <table>
      <thead>
        <tr>
          <th>Stage</th><th>Attempt</th><th>Round</th><th>Agent</th><th>Provider</th><th>Verdict</th><th>Message</th>
        </tr>
      </thead>
      <tbody id="turnRows"></tbody>
    </table>
    <script nonce="${nonce}">
      const orchestratorUrl = ${toScriptJson(orchestratorUrl)};
      const initialBundle = ${toScriptJson(bundle)};
      const eventNames = ${toScriptJson([...EVENT_NAMES])};
      const state = {
        bundle: initialBundle,
        eventSource: null,
        lastEventId: 0
      };

      function setText(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        element.textContent = value;
      }

      function formatVerification(bundle) {
        if (!bundle.latestVerification) {
          return { result: "none", failures: "-", commands: "-" };
        }
        return {
          result: bundle.latestVerification.passed ? "PASS" : "FAIL",
          failures: (bundle.latestVerification.failures || []).join(", ") || "-",
          commands: (bundle.latestVerification.commands || []).join(", ") || "-"
        };
      }

      function renderTurns(turns) {
        const tbody = document.getElementById("turnRows");
        if (!tbody) return;
        tbody.replaceChildren();
        for (const turn of turns) {
          const tr = document.createElement("tr");
          const cells = [
            turn.stage,
            String(turn.attempt),
            String(turn.round),
            turn.agentId,
            turn.provider,
            turn.verdict,
            turn.message
          ];
          for (const cellValue of cells) {
            const td = document.createElement("td");
            td.textContent = cellValue;
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }

      function render(bundle) {
        setText("taskTitle", "Task " + bundle.task.id);
        setText("taskStatus", bundle.task.status);
        setText("taskStage", bundle.task.currentStage);
        setText("taskError", bundle.task.lastError || "-");

        const verification = formatVerification(bundle);
        setText("verificationResult", verification.result);
        setText("verificationFailures", verification.failures);
        setText("verificationCommands", verification.commands);

        if (bundle.latestPatch) {
          setText("patchSummary", bundle.latestPatch.summary);
          setText("patchConfidence", String(bundle.latestPatch.confidence));
          setText("patchTouched", (bundle.latestPatch.touchedFiles || []).join(", ") || "-");
        } else {
          setText("patchSummary", "none");
          setText("patchConfidence", "-");
          setText("patchTouched", "-");
        }

        setText("turnCount", String((bundle.turns || []).length));
        setText("updatedAt", new Date().toISOString());
        renderTurns(bundle.turns || []);
      }

      async function refreshBundle() {
        const response = await fetch(orchestratorUrl + "/tasks/" + encodeURIComponent(state.bundle.task.id));
        if (!response.ok) {
          throw new Error("Refresh failed: " + response.status);
        }
        state.bundle = await response.json();
        render(state.bundle);
      }

      function setConnectionState(text) {
        setText("connectionState", text);
      }

      function connectEvents() {
        const suffix = state.lastEventId > 0 ? ("?lastEventId=" + state.lastEventId) : "";
        const eventUrl = orchestratorUrl + "/events/" + encodeURIComponent(state.bundle.task.id) + suffix;
        state.eventSource = new EventSource(eventUrl);
        setConnectionState("connected");

        for (const eventName of eventNames) {
          state.eventSource.addEventListener(eventName, async (event) => {
            if (event && event.lastEventId) {
              const parsed = Number(event.lastEventId);
              if (Number.isFinite(parsed)) {
                state.lastEventId = parsed;
              }
            }
            try {
              await refreshBundle();
            } catch {}
          });
        }

        state.eventSource.onerror = () => {
          setConnectionState("reconnecting...");
        };
      }

      const refreshBtn = document.getElementById("refreshBtn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", async () => {
          try {
            await refreshBundle();
            setConnectionState("manual refresh complete");
          } catch (error) {
            setConnectionState("manual refresh failed");
          }
        });
      }

      window.addEventListener("beforeunload", () => {
        if (state.eventSource) {
          state.eventSource.close();
        }
      });

      render(state.bundle);
      connectEvents();
    </script>
  </body>
  </html>`;
}

function renderStudioHtml(
  initial: { orchestratorUrl: string; runtime: RuntimeSettingsSummary; taskId?: string },
  cspSource: string,
  nonce: string
): string {
  const connectOrigin = getConnectOrigin(initial.orchestratorUrl);
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${connectOrigin};"
    />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 12px;
        font-family: var(--vscode-font-family, Segoe UI, sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .header {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 10px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(180px, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .summary-item {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
        background: var(--vscode-sideBar-background);
        font-size: 12px;
      }
      .row { margin: 2px 0; word-break: break-all; }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .actions button {
        min-width: 120px;
      }
      .split {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        min-height: 70vh;
      }
      @media (max-width: 980px) {
        .split { grid-template-columns: 1fr; }
        .summary-grid { grid-template-columns: 1fr; }
      }
      .panel {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 10px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        min-height: 440px;
      }
      .panel h3, .panel h4 {
        margin: 0 0 8px 0;
      }
      .chat-stream {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
        overflow: auto;
        flex: 1;
        background: var(--vscode-editor-background);
      }
      .chat-item {
        margin-bottom: 8px;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
      }
      .chat-user { background: color-mix(in srgb, var(--vscode-button-background) 28%, transparent); }
      .chat-assistant { background: color-mix(in srgb, var(--vscode-inputValidation-infoBorder) 20%, transparent); }
      .chat-author {
        font-size: 11px;
        opacity: 0.85;
        margin-bottom: 4px;
        font-weight: 700;
      }
      .chat-body { white-space: pre-wrap; font-size: 13px; line-height: 1.4; }
      .composer {
        margin-top: 8px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      textarea, input, button {
        border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
        border-radius: 7px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        font-size: 12px;
        box-sizing: border-box;
      }
      textarea, input { padding: 8px; }
      textarea {
        resize: vertical;
        min-height: 62px;
      }
      button {
        padding: 8px 10px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        font-weight: 700;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      .decision-row {
        margin-top: 8px;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
      }
      .tiny-meta {
        margin-top: 6px;
        font-size: 11px;
        opacity: 0.8;
      }
      .debate-stream {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
        overflow: auto;
        flex: 1;
        background: var(--vscode-editor-background);
      }
      .turn-card {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
        margin-bottom: 8px;
      }
      .turn-head {
        font-size: 11px;
        opacity: 0.85;
        margin-bottom: 4px;
      }
      .turn-body {
        font-size: 12px;
        white-space: pre-wrap;
        line-height: 1.35;
      }
      .event-log {
        margin-top: 8px;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 8px;
        overflow: auto;
        max-height: 180px;
        background: var(--vscode-editor-background);
      }
      .event-line {
        font-size: 11px;
        white-space: pre-wrap;
        margin-bottom: 4px;
        opacity: 0.92;
      }
      .status-ok { color: #4caf50; }
      .status-warn { color: #ff9800; }
      .status-bad { color: #f44336; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="summary-grid">
        <div class="summary-item">
          <div class="row"><b>Task:</b> <span id="taskId">-</span></div>
          <div class="row"><b>Status:</b> <span id="taskStatus">idle</span></div>
          <div class="row"><b>Stage:</b> <span id="taskStage">-</span></div>
        </div>
        <div class="summary-item">
          <div class="row"><b>API:</b> <span id="apiUrl">-</span></div>
          <div class="row"><b>OpenAI:</b> <span id="openAIStatus">not set</span></div>
          <div class="row"><b>Anthropic:</b> <span id="anthropicStatus">not set</span></div>
          <div class="row"><b>Gemini:</b> <span id="geminiStatus">not set</span></div>
          <div class="row"><b>Writer:</b> <span id="driverStatus">auto</span></div>
        </div>
        <div class="summary-item">
          <div class="row"><b>Conn:</b> <span id="connectionState">idle</span></div>
          <div class="row"><b>Turns:</b> <span id="turnCount">0</span></div>
          <div class="row"><b>Verify:</b> <span id="verifyState">none</span></div>
          <div class="row"><b>Error:</b> <span id="taskError">-</span></div>
        </div>
      </div>
      <div class="actions">
        <button id="refreshTaskBtn">Refresh Task</button>
        <button id="showLogBtn">Open Log Window</button>
      </div>
    </div>

    <div class="split">
      <section class="panel">
        <h3>Command Chat</h3>
        <div id="chatStream" class="chat-stream"></div>
        <div class="composer">
          <textarea id="goalInput" placeholder="Example: Refactor login API and make all tests pass"></textarea>
          <button id="sendBtn">Send</button>
        </div>
        <input id="decisionNote" type="text" placeholder="Decision note (optional)" />
        <div class="decision-row">
          <button id="approveBtn">Approve</button>
          <button id="rejectBtn">Reject</button>
          <button id="retryBtn">Retry</button>
        </div>
        <div class="tiny-meta">Studio layout: left panel = commands/final summary, right panel = debate/events</div>
      </section>

      <section class="panel">
        <h3>Debate Live</h3>
        <div id="debateStream" class="debate-stream"></div>
        <h4>Event Log</h4>
        <div id="eventLog" class="event-log"></div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const initial = ${toScriptJson({
        orchestratorUrl: initial.orchestratorUrl,
        runtime: initial.runtime,
        taskId: initial.taskId ?? "",
        eventNames: [...EVENT_NAMES]
      })};
      const terminalStatuses = new Set(["completed", "failed", "stopped_budget"]);
      const state = {
        orchestratorUrl: initial.orchestratorUrl,
        runtime: initial.runtime,
        taskId: initial.taskId || "",
        bundle: null,
        eventSource: null,
        lastEventId: 0,
        announcedStatus: "",
        refreshQueued: false
      };

      function byId(id) {
        return document.getElementById(id);
      }

      function setText(id, value) {
        const el = byId(id);
        if (!el) return;
        el.textContent = value;
      }

      function nowTime() {
        return new Date().toLocaleTimeString();
      }

      function addChat(role, message) {
        const stream = byId("chatStream");
        if (!stream) return;
        const item = document.createElement("div");
        item.className = "chat-item " + (role === "user" ? "chat-user" : "chat-assistant");

        const author = document.createElement("div");
        author.className = "chat-author";
        author.textContent = (role === "user" ? "YOU" : "HUB") + " - " + nowTime();

        const body = document.createElement("div");
        body.className = "chat-body";
        body.textContent = message;

        item.appendChild(author);
        item.appendChild(body);
        stream.appendChild(item);
        stream.scrollTop = stream.scrollHeight;
      }

      function addEvent(type, message) {
        const log = byId("eventLog");
        if (!log) return;
        const line = document.createElement("div");
        line.className = "event-line";
        line.textContent = "[" + nowTime() + "] " + type + " " + message;
        log.prepend(line);
      }

      function summarizeOutcome(bundle) {
        const status = bundle && bundle.task ? bundle.task.status : "unknown";
        const verify = bundle && bundle.latestVerification
          ? (bundle.latestVerification.passed ? "verification PASS" : "verification FAIL: " + ((bundle.latestVerification.failures || []).join(", ") || "unknown"))
          : "verification none";
        const patch = bundle && bundle.latestPatch
          ? "patch: " + (bundle.latestPatch.summary || "applied")
          : "patch: none";
        const reason = bundle && bundle.task && bundle.task.lastError ? " reason: " + bundle.task.lastError : "";

        if (status === "completed") return "Final: auto-apply completed. " + verify + " / " + patch;
        if (status === "needs_human_decision") return "Final: human decision required." + reason + " / " + verify + " / " + patch;
        if (status === "stopped_budget") return "Final: stopped by budget limit." + reason;
        if (status === "failed") return "Final: task failed." + reason + " / " + verify;
        return "Task is running.";
      }

      function renderTurns(turns) {
        const container = byId("debateStream");
        if (!container) return;
        container.replaceChildren();
        if (!Array.isArray(turns) || turns.length === 0) {
          const empty = document.createElement("div");
          empty.className = "turn-card";
          empty.textContent = "No turns yet.";
          container.appendChild(empty);
          return;
        }

        for (const turn of turns) {
          const card = document.createElement("div");
          card.className = "turn-card";
          const head = document.createElement("div");
          head.className = "turn-head";
          head.textContent =
            (turn.stage || "-") +
            " | a" + String(turn.attempt) +
            " r" + String(turn.round) +
            " | " + (turn.agentId || "-") +
            " (" + (turn.provider || "-") + ")" +
            " | " + (turn.verdict || "-");
          const body = document.createElement("div");
          body.className = "turn-body";
          body.textContent = turn.message || "";
          card.appendChild(head);
          card.appendChild(body);
          container.appendChild(card);
        }
        container.scrollTop = container.scrollHeight;
      }

      function renderBundle(bundle) {
        state.bundle = bundle;
        const task = bundle && bundle.task ? bundle.task : null;
        if (!task) return;

        setText("taskId", task.id || "-");
        setText("taskStatus", task.status || "-");
        setText("taskStage", task.currentStage || "-");
        setText("taskError", task.lastError || "-");

        const turns = Array.isArray(bundle.turns) ? bundle.turns : [];
        setText("turnCount", String(turns.length));
        const verify = bundle.latestVerification
          ? (bundle.latestVerification.passed ? "PASS" : "FAIL")
          : "none";
        setText("verifyState", verify);
        renderTurns(turns);

        if (state.announcedStatus !== task.status && (terminalStatuses.has(task.status) || task.status === "needs_human_decision")) {
          state.announcedStatus = task.status;
          const finalMessage = summarizeOutcome(bundle);
          addChat("assistant", finalMessage);
          addEvent("final", finalMessage);
        }
      }

      async function fetchBundle(taskId) {
        const response = await fetch(state.orchestratorUrl + "/tasks/" + encodeURIComponent(taskId));
        if (!response.ok) {
          throw new Error("Task fetch failed: " + response.status);
        }
        return await response.json();
      }

      async function refreshTask(reason) {
        if (!state.taskId) return;
        try {
          const bundle = await fetchBundle(state.taskId);
          renderBundle(bundle);
          setText("connectionState", reason || "updated");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setText("connectionState", "refresh failed");
          addEvent("error", message);
        }
      }

      function queueRefresh(reason) {
        if (state.refreshQueued) return;
        state.refreshQueued = true;
        setTimeout(async () => {
          state.refreshQueued = false;
          await refreshTask(reason);
        }, 120);
      }

      function disconnectEvents() {
        if (state.eventSource) {
          state.eventSource.close();
          state.eventSource = null;
        }
      }

      function connectEvents() {
        if (!state.taskId) return;
        disconnectEvents();

        const suffix = state.lastEventId > 0 ? ("?lastEventId=" + state.lastEventId) : "";
        const eventUrl = state.orchestratorUrl + "/events/" + encodeURIComponent(state.taskId) + suffix;
        state.eventSource = new EventSource(eventUrl);
        setText("connectionState", "connected");

        for (const eventName of initial.eventNames || []) {
          state.eventSource.addEventListener(eventName, (event) => {
            if (event && event.lastEventId) {
              const parsed = Number(event.lastEventId);
              if (Number.isFinite(parsed)) {
                state.lastEventId = parsed;
              }
            }
            let payload = null;
            try {
              payload = event && event.data ? JSON.parse(event.data) : null;
            } catch {}
            const stage = payload && payload.stage ? " stage=" + payload.stage : "";
            const detail = payload && payload.data ? " " + JSON.stringify(payload.data) : "";
            addEvent(eventName, stage + detail);
            queueRefresh("live");
          });
        }

        state.eventSource.onerror = () => {
          setText("connectionState", "reconnecting...");
        };
      }

      function setRuntimeStatus() {
        setText("apiUrl", state.orchestratorUrl || "-");
        setText("openAIStatus", state.runtime && state.runtime.openAIApiKeyConfigured ? "configured" : "not set");
        setText("anthropicStatus", state.runtime && state.runtime.anthropicApiKeyConfigured ? "configured" : "not set");
        setText("geminiStatus", state.runtime && state.runtime.geminiApiKeyConfigured ? "configured" : "not set");
        setText("driverStatus", state.runtime && state.runtime.driverAgentId ? state.runtime.driverAgentId : "auto");
      }

      function onStart() {
        const goalInput = byId("goalInput");
        const goal = goalInput && goalInput.value ? goalInput.value.trim() : "";
        if (!goal) {
          addEvent("warn", "Goal is empty.");
          return;
        }
        addChat("user", goal);
        if (goalInput) goalInput.value = "";
        setText("connectionState", "starting task...");
        vscode.postMessage({ command: "startTask", userGoal: goal });
      }

      function onDecision(action) {
        if (!state.taskId) {
          addEvent("warn", "No active task.");
          return;
        }
        const noteInput = byId("decisionNote");
        const note = noteInput && noteInput.value ? noteInput.value.trim() : "";
        vscode.postMessage({
          command: "decision",
          taskId: state.taskId,
          action: action,
          note: note || undefined
        });
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "taskBundle" && msg.bundle && msg.bundle.task) {
          const nextTaskId = msg.bundle.task.id;
          const changedTask = state.taskId !== nextTaskId;
          state.taskId = nextTaskId;
          state.announcedStatus = changedTask ? "" : state.announcedStatus;
          renderBundle(msg.bundle);
          connectEvents();
          vscode.postMessage({ command: "rememberTask", taskId: state.taskId });
          if (msg.source === "start") {
            const goal = msg.bundle.request && msg.bundle.request.userGoal ? msg.bundle.request.userGoal : "";
            addChat("assistant", "Task started: " + state.taskId + (goal ? "\\nGoal: " + goal : ""));
          }
          return;
        }

        if (msg.type === "error") {
          const text = msg.message || "Unknown error";
          addChat("assistant", "Error: " + text);
          addEvent("error", text);
          setText("connectionState", "error");
          return;
        }
      });

      const sendBtn = byId("sendBtn");
      if (sendBtn) {
        sendBtn.addEventListener("click", onStart);
      }
      const goalInput = byId("goalInput");
      if (goalInput) {
        goalInput.addEventListener("keydown", (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onStart();
          }
        });
      }

      const approveBtn = byId("approveBtn");
      if (approveBtn) approveBtn.addEventListener("click", () => onDecision("approve_patch"));
      const rejectBtn = byId("rejectBtn");
      if (rejectBtn) rejectBtn.addEventListener("click", () => onDecision("reject_patch"));
      const retryBtn = byId("retryBtn");
      if (retryBtn) retryBtn.addEventListener("click", () => onDecision("retry_step"));
      const refreshBtn = byId("refreshTaskBtn");
      if (refreshBtn) refreshBtn.addEventListener("click", () => refreshTask("manual"));
      const showLogBtn = byId("showLogBtn");
      if (showLogBtn) {
        showLogBtn.addEventListener("click", () => vscode.postMessage({ command: "openDebateLog", taskId: state.taskId }));
      }

      window.addEventListener("beforeunload", () => {
        disconnectEvents();
      });

      setRuntimeStatus();
      if (state.taskId) {
        addChat("assistant", "Reconnected to existing task: " + state.taskId);
        refreshTask("restore").then(() => connectEvents());
      } else {
        addChat("assistant", "Type your goal in Command Chat and click Send to start.");
      }
    </script>
  </body>
  </html>`;
}

async function postDecision(context: vscode.ExtensionContext, action: DecisionAction) {
  const taskId = await resolveTaskId(context);
  if (!taskId) return;
  const note = await vscode.window.showInputBox({
    title: `${action} note`,
    prompt: "Optional note",
    ignoreFocusOut: true
  });
  const url = `${getOrchestratorUrl()}/tasks/${taskId}/decision`;
  await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, note: note?.trim() || undefined })
  });
  vscode.window.showInformationMessage(`Decision sent: ${action}`);
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Multi-Agent Debate");
  context.subscriptions.push(output);
  const sidebarProvider = new MultiAgentSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MultiAgentSidebarProvider.viewType, sidebarProvider)
  );
  let studioPanel: vscode.WebviewPanel | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.openStudio", async () => {
      if (studioPanel) {
        studioPanel.reveal(vscode.ViewColumn.One);
        return;
      }

      const orchestratorUrl = getOrchestratorUrl();
      const runtime = await fetchRuntimeSettings(orchestratorUrl);
      studioPanel = vscode.window.createWebviewPanel(
        "multiAgentStudio",
        "Multi-Agent Studio",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const panel = studioPanel;
      panel.webview.html = renderStudioHtml(
        {
          orchestratorUrl,
          runtime,
          taskId: context.globalState.get<string>(LAST_TASK_KEY)
        },
        panel.webview.cspSource,
        createNonce()
      );

      panel.onDidDispose(() => {
        if (studioPanel === panel) {
          studioPanel = undefined;
        }
      });

      panel.webview.onDidReceiveMessage(
        async (message: StudioMessage) => {
          const command = message?.command;
          if (!command) return;

          if (command === "rememberTask") {
            if (message.taskId?.trim()) {
              await context.globalState.update(LAST_TASK_KEY, message.taskId.trim());
              sidebarProvider.refresh();
            }
            return;
          }

          if (command === "openDebateLog") {
            const taskId = message.taskId?.trim() || context.globalState.get<string>(LAST_TASK_KEY);
            if (!taskId) {
              panel.webview.postMessage({ type: "error", message: "Task ID is required." });
              return;
            }
            await context.globalState.update(LAST_TASK_KEY, taskId);
            await vscode.commands.executeCommand("multiAgent.showDebateLog");
            return;
          }

          if (command === "startTask") {
            const userGoal = message.userGoal?.trim();
            if (!userGoal) {
              panel.webview.postMessage({ type: "error", message: "Goal is required." });
              return;
            }

            const workspacePath = await resolveWorkspacePath();
            if (!workspacePath) {
              panel.webview.postMessage({
                type: "error",
                message: "Workspace folder is required. Open/select a folder and retry."
              });
              return;
            }

            try {
              const bundle = await fetchJson<TaskBundle>(`${getOrchestratorUrl()}/tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspacePath, userGoal })
              });
              await context.globalState.update(LAST_TASK_KEY, bundle.task.id);
              panel.webview.postMessage({ type: "taskBundle", source: "start", bundle });
              output.appendLine(`[studio.startTask] taskId=${bundle.task.id}`);
              sidebarProvider.refresh();
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              output.appendLine(`[studio.startTask][error] ${text}`);
              panel.webview.postMessage({ type: "error", message: text });
              sidebarProvider.refresh();
            }
            return;
          }

          if (command === "decision") {
            const taskId = message.taskId?.trim() || context.globalState.get<string>(LAST_TASK_KEY);
            if (!taskId || !message.action) {
              panel.webview.postMessage({ type: "error", message: "Task ID and decision action are required." });
              return;
            }
            try {
              const bundle = await fetchJson<TaskBundle>(`${getOrchestratorUrl()}/tasks/${taskId}/decision`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: message.action,
                  note: message.note?.trim() || undefined
                })
              });
              await context.globalState.update(LAST_TASK_KEY, bundle.task.id);
              panel.webview.postMessage({ type: "taskBundle", source: "decision", bundle });
              output.appendLine(`[studio.decision] taskId=${bundle.task.id} action=${message.action}`);
              sidebarProvider.refresh();
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              output.appendLine(`[studio.decision][error] ${text}`);
              panel.webview.postMessage({ type: "error", message: text });
              sidebarProvider.refresh();
            }
          }
        },
        undefined,
        context.subscriptions
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.startTask", async () => {
      const workspacePath = await resolveWorkspacePath();
      if (!workspacePath) {
        vscode.window.showErrorMessage("Workspace folder is required. Select a folder and try again.");
        return;
      }
      const userGoal = await vscode.window.showInputBox({
        title: "Start Multi-Agent Task",
        prompt: "Describe the coding goal",
        ignoreFocusOut: true
      });
      if (!userGoal?.trim()) return;

      try {
        const bundle = await fetchJson<TaskBundle>(`${getOrchestratorUrl()}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspacePath,
            userGoal: userGoal.trim()
          })
        });
        await context.globalState.update(LAST_TASK_KEY, bundle.task.id);
        output.appendLine(`[startTask] taskId=${bundle.task.id}`);
        vscode.window.showInformationMessage(`Task started: ${bundle.task.id}`);
        sidebarProvider.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[startTask][error] ${message}`);
        vscode.window.showErrorMessage(`Start failed: ${message}`);
        sidebarProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.approvePatch", async () => {
      await postDecision(context, "approve_patch");
      sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.rejectPatch", async () => {
      await postDecision(context, "reject_patch");
      sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.retryStep", async () => {
      await postDecision(context, "retry_step");
      sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.showDebateLog", async () => {
      const taskId = await resolveTaskId(context);
      if (!taskId) return;
      const orchestratorUrl = getOrchestratorUrl();
      const url = `${orchestratorUrl}/tasks/${taskId}`;
      try {
        const bundle = await fetchJson<TaskBundle>(url);
        const panel = vscode.window.createWebviewPanel(
          "multiAgentDebateLog",
          `Debate Log: ${taskId}`,
          vscode.ViewColumn.Two,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = renderDebateHtml(bundle, orchestratorUrl, panel.webview.cspSource, createNonce());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Load log failed: ${message}`);
      }
      sidebarProvider.refresh();
    })
  );
}

export function deactivate() {}


