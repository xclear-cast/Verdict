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
      .top-row { display: flex; justify-content: flex-end; margin-bottom: 8px; }
      .lang-btn { min-width: 56px; }
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
    <div class="top-row">
      <button id="langToggleBtn" class="lang-btn" type="button">KO</button>
    </div>
    <div class="card">
      <div class="title" data-i18n="sidebar.title">Multi-Agent</div>
      <div class="meta"><span data-i18n="sidebar.taskLabel">Task:</span> <span id="taskId">-</span></div>
      <div class="meta"><span data-i18n="sidebar.apiLabel">API:</span> <span id="apiUrl">-</span></div>
      <div class="meta"><span data-i18n="sidebar.openaiLabel">OpenAI Key:</span> <span id="openAIStatus">not set</span></div>
      <div class="meta"><span data-i18n="sidebar.anthropicLabel">Anthropic Key:</span> <span id="anthropicStatus">not set</span></div>
      <div class="meta"><span data-i18n="sidebar.geminiLabel">Gemini Key:</span> <span id="geminiStatus">not set</span></div>
      <div class="meta"><span data-i18n="sidebar.writerLabel">Writer Agent:</span> <span id="driverStatus">auto</span></div>
      <div class="meta"><span data-i18n="sidebar.debatePolicyLabel">Debate Policy:</span> <span id="debateStatus">default</span></div>
      <div class="meta"><span data-i18n="sidebar.budgetLabel">Budget Limits:</span> <span id="budgetStatus">default</span></div>
      <div id="status" data-i18n="sidebar.status.ready">Ready</div>
    </div>

    <div class="card">
      <div class="title" data-i18n="sidebar.apiSettings">API Settings</div>
      <input id="openAIKeyInput" type="password" data-i18n-placeholder="sidebar.placeholder.openai" placeholder="OpenAI API key (optional)" />
      <input id="anthropicKeyInput" type="password" data-i18n-placeholder="sidebar.placeholder.anthropic" placeholder="Anthropic API key (optional)" />
      <input id="geminiKeyInput" type="password" data-i18n-placeholder="sidebar.placeholder.gemini" placeholder="Google Gemini API key (optional)" />
      <input id="driverIdInput" type="text" data-i18n-placeholder="sidebar.placeholder.writer" placeholder="Writer Agent ID (optional, e.g. coder-openai)" />
      <div class="actions" style="margin-top:8px;">
        <button class="full" data-action="saveApiSettings" data-i18n="sidebar.button.saveApi">Save API Keys</button>
      </div>
    </div>

    <div class="card">
      <div class="title" data-i18n="sidebar.debateBudget">Debate & Budget Settings</div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxDebateRounds">Max Debate Rounds</span> <button type="button" class="help-btn" data-help="maxDebateRounds">?</button></div>
        <input id="maxDebateRoundsInput" type="number" min="1" max="5" placeholder="2" />
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxRetriesPerStage">Max Retries Per Stage</span> <button type="button" class="help-btn" data-help="maxRetriesPerStage">?</button></div>
        <input id="maxRetriesPerStageInput" type="number" min="0" max="10" placeholder="2" />
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.consensusMode">Consensus Mode</span> <button type="button" class="help-btn" data-help="consensusMode">?</button></div>
        <select id="consensusModeInput">
          <option id="consensusModeDefaultOption" value="">default (unanimous)</option>
          <option id="consensusModeUnanimousOption" value="unanimous">unanimous</option>
          <option id="consensusModeQuorumOption" value="quorum">quorum</option>
          <option id="consensusModeJudgeOption" value="judge">judge</option>
        </select>
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.quorumRatio">Quorum Ratio</span> <button type="button" class="help-btn" data-help="quorumRatio">?</button></div>
        <input id="quorumRatioInput" type="number" min="0.5" max="1" step="0.01" placeholder="1.0" />
      </div>
      <div class="check-field">
        <input id="criticalOnlyInput" type="checkbox" />
        <span data-i18n="sidebar.label.criticalOnly">Critical-only review in final round</span>
        <button type="button" class="help-btn" data-help="criticalOnlyInFinalRound">?</button>
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxStageExecutions">Max Stage Executions</span> <button type="button" class="help-btn" data-help="maxStageExecutions">?</button></div>
        <input id="maxStageExecutionsInput" type="number" min="1" max="20" placeholder="5" />
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxModelCallsPerStage">Max Model Calls Per Stage</span> <button type="button" class="help-btn" data-help="maxModelCallsPerStage">?</button></div>
        <input id="maxModelCallsPerStageInput" type="number" min="1" max="200" placeholder="4" />
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxModelCallsPerTask">Max Model Calls Per Task</span> <button type="button" class="help-btn" data-help="maxModelCallsPerTask">?</button></div>
        <input id="maxModelCallsPerTaskInput" type="number" min="1" max="2000" placeholder="40" />
      </div>
      <div class="field">
        <div class="field-label"><span data-i18n="sidebar.label.maxCostUsd">Max Cost USD</span> <button type="button" class="help-btn" data-help="maxCostUsd">?</button></div>
        <input id="maxCostUsdInput" type="number" min="0.01" max="1000" step="0.01" placeholder="1.00" />
      </div>
      <div class="actions" style="margin-top:8px;">
        <button class="full" data-action="saveApiSettings" data-i18n="sidebar.button.saveDebate">Save Debate/Budget</button>
      </div>
    </div>

    <div class="actions">
      <button class="full" data-action="openStudio" data-i18n="sidebar.button.openStudio">Open Studio</button>
      <button class="full" data-action="refreshState" data-i18n="sidebar.button.refresh">Refresh</button>
    </div>

    <div id="helpModal" class="help-modal hidden">
      <div class="help-card">
        <div id="helpTitle" class="help-title" data-i18n="sidebar.help.title">Help</div>
        <div id="helpBody" class="help-body"></div>
        <div class="actions">
          <button id="helpCloseBtn" class="full" type="button" data-i18n="sidebar.button.close">Close</button>
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
      const langToggleBtn = document.getElementById("langToggleBtn");
      const consensusModeDefaultOption = document.getElementById("consensusModeDefaultOption");
      const consensusModeUnanimousOption = document.getElementById("consensusModeUnanimousOption");
      const consensusModeQuorumOption = document.getElementById("consensusModeQuorumOption");
      const consensusModeJudgeOption = document.getElementById("consensusModeJudgeOption");

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

      const sidebarLangStorageKey = "multiAgent.sidebar.lang";
      let currentLang = "en";
      try {
        const savedLang = localStorage.getItem(sidebarLangStorageKey);
        if (savedLang === "ko" || savedLang === "en") {
          currentLang = savedLang;
        }
      } catch {}

      const i18n = {
        en: {
          "sidebar.title": "Multi-Agent",
          "sidebar.taskLabel": "Task:",
          "sidebar.apiLabel": "API:",
          "sidebar.openaiLabel": "OpenAI Key:",
          "sidebar.anthropicLabel": "Anthropic Key:",
          "sidebar.geminiLabel": "Gemini Key:",
          "sidebar.writerLabel": "Writer Agent:",
          "sidebar.debatePolicyLabel": "Debate Policy:",
          "sidebar.budgetLabel": "Budget Limits:",
          "sidebar.apiSettings": "API Settings",
          "sidebar.debateBudget": "Debate & Budget Settings",
          "sidebar.label.maxDebateRounds": "Max Debate Rounds",
          "sidebar.label.maxRetriesPerStage": "Max Retries Per Stage",
          "sidebar.label.consensusMode": "Consensus Mode",
          "sidebar.label.quorumRatio": "Quorum Ratio",
          "sidebar.label.criticalOnly": "Critical-only review in final round",
          "sidebar.label.maxStageExecutions": "Max Stage Executions",
          "sidebar.label.maxModelCallsPerStage": "Max Model Calls Per Stage",
          "sidebar.label.maxModelCallsPerTask": "Max Model Calls Per Task",
          "sidebar.label.maxCostUsd": "Max Cost USD",
          "sidebar.button.saveApi": "Save API Keys",
          "sidebar.button.saveDebate": "Save Debate/Budget",
          "sidebar.button.openStudio": "Open Studio",
          "sidebar.button.refresh": "Refresh",
          "sidebar.button.close": "Close",
          "sidebar.help.title": "Help",
          "sidebar.placeholder.openai": "OpenAI API key (optional)",
          "sidebar.placeholder.anthropic": "Anthropic API key (optional)",
          "sidebar.placeholder.gemini": "Google Gemini API key (optional)",
          "sidebar.placeholder.writer": "Writer Agent ID (optional, e.g. coder-openai)",
          "sidebar.status.ready": "Ready",
          "sidebar.status.running": "Running...",
          "sidebar.status.done": "Done",
          "sidebar.status.notSet": "not set",
          "sidebar.status.configured": "configured",
          "sidebar.status.auto": "auto",
          "sidebar.consensus.default": "default (unanimous)",
          "sidebar.consensus.unanimous": "unanimous",
          "sidebar.consensus.quorum": "quorum",
          "sidebar.consensus.judge": "judge"
        },
        ko: {
          "sidebar.title": "멀티 에이전트",
          "sidebar.taskLabel": "작업:",
          "sidebar.apiLabel": "API:",
          "sidebar.openaiLabel": "OpenAI 키:",
          "sidebar.anthropicLabel": "Anthropic 키:",
          "sidebar.geminiLabel": "Gemini 키:",
          "sidebar.writerLabel": "작성 에이전트:",
          "sidebar.debatePolicyLabel": "토론 정책:",
          "sidebar.budgetLabel": "예산 제한:",
          "sidebar.apiSettings": "API 설정",
          "sidebar.debateBudget": "토론/예산 설정",
          "sidebar.label.maxDebateRounds": "최대 토론 라운드",
          "sidebar.label.maxRetriesPerStage": "단계별 최대 재시도",
          "sidebar.label.consensusMode": "합의 모드",
          "sidebar.label.quorumRatio": "정족수 비율",
          "sidebar.label.criticalOnly": "최종 라운드에서 치명 이슈만 검토",
          "sidebar.label.maxStageExecutions": "최대 단계 실행 수",
          "sidebar.label.maxModelCallsPerStage": "단계별 최대 모델 호출",
          "sidebar.label.maxModelCallsPerTask": "작업별 최대 모델 호출",
          "sidebar.label.maxCostUsd": "최대 비용(USD)",
          "sidebar.button.saveApi": "API 키 저장",
          "sidebar.button.saveDebate": "토론/예산 저장",
          "sidebar.button.openStudio": "스튜디오 열기",
          "sidebar.button.refresh": "새로고침",
          "sidebar.button.close": "닫기",
          "sidebar.help.title": "도움말",
          "sidebar.placeholder.openai": "OpenAI API 키 (선택)",
          "sidebar.placeholder.anthropic": "Anthropic API 키 (선택)",
          "sidebar.placeholder.gemini": "Google Gemini API 키 (선택)",
          "sidebar.placeholder.writer": "작성 에이전트 ID (선택, 예: coder-openai)",
          "sidebar.status.ready": "준비됨",
          "sidebar.status.running": "실행 중...",
          "sidebar.status.done": "완료",
          "sidebar.status.notSet": "미설정",
          "sidebar.status.configured": "설정됨",
          "sidebar.status.auto": "자동",
          "sidebar.consensus.default": "기본값 (만장일치)",
          "sidebar.consensus.unanimous": "만장일치",
          "sidebar.consensus.quorum": "정족수",
          "sidebar.consensus.judge": "판정자"
        }
      };

      const helpTextsByLang = {
        en: {
          maxDebateRounds: { title: "Max Debate Rounds", body: "Sets how many rounds agents can debate per stage." },
          maxRetriesPerStage: { title: "Max Retries Per Stage", body: "How many retries are allowed for each stage." },
          consensusMode: { title: "Consensus Mode", body: "unanimous: all approve, quorum: ratio threshold, judge: judge role decides." },
          quorumRatio: { title: "Quorum Ratio", body: "Only used in quorum mode. Example: 0.67 means 67%+ approvals." },
          criticalOnlyInFinalRound: { title: "Critical-only Final Round", body: "Final round focuses on critical issues only." },
          maxStageExecutions: { title: "Max Stage Executions", body: "Maximum stage executions per task." },
          maxModelCallsPerStage: { title: "Max Model Calls Per Stage", body: "Maximum model calls allowed in one stage." },
          maxModelCallsPerTask: { title: "Max Model Calls Per Task", body: "Maximum model calls allowed in one task." },
          maxCostUsd: { title: "Max Cost USD", body: "Estimated per-task cost ceiling; task stops when exceeded." }
        },
        ko: {
          maxDebateRounds: { title: "최대 토론 라운드", body: "각 단계에서 에이전트가 토론할 수 있는 최대 라운드 수입니다." },
          maxRetriesPerStage: { title: "단계별 최대 재시도", body: "각 단계 실패 시 자동 재시도 가능한 횟수입니다." },
          consensusMode: { title: "합의 모드", body: "unanimous: 전원 승인, quorum: 비율 충족, judge: 판정자 결정." },
          quorumRatio: { title: "정족수 비율", body: "quorum 모드에서만 사용됩니다. 예: 0.67은 67% 이상 승인." },
          criticalOnlyInFinalRound: { title: "최종 라운드 치명 이슈만", body: "최종 라운드에서 스타일 지적은 줄이고 치명 이슈만 검토합니다." },
          maxStageExecutions: { title: "최대 단계 실행 수", body: "작업 1개에서 단계를 실행할 수 있는 최대 횟수입니다." },
          maxModelCallsPerStage: { title: "단계별 최대 모델 호출", body: "단일 단계에서 허용되는 모델 호출 최대 횟수입니다." },
          maxModelCallsPerTask: { title: "작업별 최대 모델 호출", body: "작업 전체에서 허용되는 모델 호출 최대 횟수입니다." },
          maxCostUsd: { title: "최대 비용(USD)", body: "작업당 예상 비용 상한입니다. 초과 시 작업이 중단됩니다." }
        }
      };

      function t(key) {
        const table = i18n[currentLang] || i18n.en;
        return table[key] || i18n.en[key] || key;
      }

      function applyLocale() {
        document.querySelectorAll("[data-i18n]").forEach((element) => {
          const key = element.getAttribute("data-i18n");
          if (!key) return;
          element.textContent = t(key);
        });

        document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
          const key = element.getAttribute("data-i18n-placeholder");
          if (!key || !("placeholder" in element)) return;
          element.placeholder = t(key);
        });

        if (consensusModeDefaultOption) consensusModeDefaultOption.textContent = t("sidebar.consensus.default");
        if (consensusModeUnanimousOption) consensusModeUnanimousOption.textContent = t("sidebar.consensus.unanimous");
        if (consensusModeQuorumOption) consensusModeQuorumOption.textContent = t("sidebar.consensus.quorum");
        if (consensusModeJudgeOption) consensusModeJudgeOption.textContent = t("sidebar.consensus.judge");

        if (langToggleBtn) {
          langToggleBtn.textContent = currentLang === "en" ? "KO" : "EN";
        }
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
        const table = helpTextsByLang[currentLang] || helpTextsByLang.en;
        const entry = table[key] || helpTextsByLang.en[key];
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
          statusEl.textContent = t("sidebar.status.running");
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

      if (langToggleBtn) {
        langToggleBtn.addEventListener("click", () => {
          currentLang = currentLang === "en" ? "ko" : "en";
          try {
            localStorage.setItem(sidebarLangStorageKey, currentLang);
          } catch {}
          applyLocale();
        });
      }

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
          openAIStatusEl.textContent = msg.runtime?.openAIApiKeyConfigured ? t("sidebar.status.configured") : t("sidebar.status.notSet");
          anthropicStatusEl.textContent = msg.runtime?.anthropicApiKeyConfigured ? t("sidebar.status.configured") : t("sidebar.status.notSet");
          geminiStatusEl.textContent = msg.runtime?.geminiApiKeyConfigured ? t("sidebar.status.configured") : t("sidebar.status.notSet");
          driverStatusEl.textContent = msg.runtime?.driverAgentId || t("sidebar.status.auto");
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

          statusEl.textContent = t("sidebar.status.ready");
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
          statusEl.textContent = msg.message || t("sidebar.status.done");
        }
      });

      applyLocale();
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
          <div class="row"><b id="studioLblTask">Task:</b> <span id="taskId">-</span></div>
          <div class="row"><b id="studioLblStatus">Status:</b> <span id="taskStatus">idle</span></div>
          <div class="row"><b id="studioLblStage">Stage:</b> <span id="taskStage">-</span></div>
        </div>
        <div class="summary-item">
          <div class="row"><b id="studioLblApi">API:</b> <span id="apiUrl">-</span></div>
          <div class="row"><b id="studioLblOpenAI">OpenAI:</b> <span id="openAIStatus">not set</span></div>
          <div class="row"><b id="studioLblAnthropic">Anthropic:</b> <span id="anthropicStatus">not set</span></div>
          <div class="row"><b id="studioLblGemini">Gemini:</b> <span id="geminiStatus">not set</span></div>
          <div class="row"><b id="studioLblWriter">Writer:</b> <span id="driverStatus">auto</span></div>
        </div>
        <div class="summary-item">
          <div class="row"><b id="studioLblConn">Conn:</b> <span id="connectionState">idle</span></div>
          <div class="row"><b id="studioLblTurns">Turns:</b> <span id="turnCount">0</span></div>
          <div class="row"><b id="studioLblVerify">Verify:</b> <span id="verifyState">none</span></div>
          <div class="row"><b id="studioLblError">Error:</b> <span id="taskError">-</span></div>
        </div>
      </div>
      <div class="actions">
        <button id="refreshTaskBtn">Refresh Task</button>
        <button id="showLogBtn">Open Log Window</button>
        <button id="studioLangToggleBtn">KO</button>
      </div>
    </div>

    <div class="split">
      <section class="panel">
        <h3 id="studioCommandChatTitle">Command Chat</h3>
        <div id="chatStream" class="chat-stream"></div>
        <div class="composer">
          <textarea id="goalInput" data-i18n-placeholder="studio.placeholder.goal" placeholder="Example: Refactor login API and make all tests pass"></textarea>
          <button id="sendBtn">Send</button>
        </div>
        <input id="decisionNote" type="text" data-i18n-placeholder="studio.placeholder.note" placeholder="Decision note (optional)" />
        <div class="decision-row">
          <button id="approveBtn">Approve</button>
          <button id="rejectBtn">Reject</button>
          <button id="retryBtn">Retry</button>
        </div>
        <div id="studioLayoutHint" class="tiny-meta">Studio layout: left panel = commands/final summary, right panel = debate/events</div>
      </section>

      <section class="panel">
        <h3 id="studioDebateLiveTitle">Debate Live</h3>
        <div id="debateStream" class="debate-stream"></div>
        <h4 id="studioEventLogTitle">Event Log</h4>
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

      const studioLangStorageKey = "multiAgent.studio.lang";
      let currentLang = "en";
      try {
        const savedLang = localStorage.getItem(studioLangStorageKey);
        if (savedLang === "ko" || savedLang === "en") {
          currentLang = savedLang;
        }
      } catch {}

      const i18n = {
        en: {
          "studio.label.task": "Task:",
          "studio.label.status": "Status:",
          "studio.label.stage": "Stage:",
          "studio.label.api": "API:",
          "studio.label.openai": "OpenAI:",
          "studio.label.anthropic": "Anthropic:",
          "studio.label.gemini": "Gemini:",
          "studio.label.writer": "Writer:",
          "studio.label.conn": "Conn:",
          "studio.label.turns": "Turns:",
          "studio.label.verify": "Verify:",
          "studio.label.error": "Error:",
          "studio.button.refreshTask": "Refresh Task",
          "studio.button.openLog": "Open Log Window",
          "studio.button.send": "Send",
          "studio.button.approve": "Approve",
          "studio.button.reject": "Reject",
          "studio.button.retry": "Retry",
          "studio.title.commandChat": "Command Chat",
          "studio.title.debateLive": "Debate Live",
          "studio.title.eventLog": "Event Log",
          "studio.meta.layout": "Studio layout: left panel = commands/final summary, right panel = debate/events",
          "studio.placeholder.goal": "Example: Refactor login API and make all tests pass",
          "studio.placeholder.note": "Decision note (optional)",
          "studio.status.notSet": "not set",
          "studio.status.configured": "configured",
          "studio.status.auto": "auto",
          "studio.status.idle": "idle",
          "studio.status.none": "none",
          "studio.author.you": "YOU",
          "studio.author.hub": "HUB",
          "studio.turns.empty": "No turns yet.",
          "studio.warn.goalEmpty": "Goal is empty.",
          "studio.warn.noTask": "No active task.",
          "studio.error.unknown": "Unknown error",
          "studio.conn.connected": "connected",
          "studio.conn.reconnecting": "reconnecting...",
          "studio.conn.updated": "updated",
          "studio.conn.refreshFailed": "refresh failed",
          "studio.conn.starting": "starting task...",
          "studio.conn.live": "live",
          "studio.conn.manual": "manual",
          "studio.conn.restore": "restore",
          "studio.conn.error": "error",
          "studio.msg.reconnected": "Reconnected to existing task: ",
          "studio.msg.startPrompt": "Type your goal in Command Chat and click Send to start.",
          "studio.msg.taskStarted": "Task started: ",
          "studio.msg.goal": "Goal: ",
          "studio.msg.errorPrefix": "Error: "
        },
        ko: {
          "studio.label.task": "작업:",
          "studio.label.status": "상태:",
          "studio.label.stage": "단계:",
          "studio.label.api": "API:",
          "studio.label.openai": "OpenAI:",
          "studio.label.anthropic": "Anthropic:",
          "studio.label.gemini": "Gemini:",
          "studio.label.writer": "작성자:",
          "studio.label.conn": "연결:",
          "studio.label.turns": "턴:",
          "studio.label.verify": "검증:",
          "studio.label.error": "오류:",
          "studio.button.refreshTask": "작업 새로고침",
          "studio.button.openLog": "로그 창 열기",
          "studio.button.send": "보내기",
          "studio.button.approve": "승인",
          "studio.button.reject": "거절",
          "studio.button.retry": "재시도",
          "studio.title.commandChat": "명령 채팅",
          "studio.title.debateLive": "실시간 토론",
          "studio.title.eventLog": "이벤트 로그",
          "studio.meta.layout": "스튜디오 구성: 왼쪽=명령/최종결론, 오른쪽=토론/이벤트",
          "studio.placeholder.goal": "예) 로그인 API 리팩터링하고 테스트까지 통과시켜줘",
          "studio.placeholder.note": "의사결정 메모 (선택)",
          "studio.status.notSet": "미설정",
          "studio.status.configured": "설정됨",
          "studio.status.auto": "자동",
          "studio.status.idle": "대기",
          "studio.status.none": "없음",
          "studio.author.you": "사용자",
          "studio.author.hub": "허브",
          "studio.turns.empty": "아직 토론 턴이 없습니다.",
          "studio.warn.goalEmpty": "목표가 비어 있습니다.",
          "studio.warn.noTask": "활성 작업이 없습니다.",
          "studio.error.unknown": "알 수 없는 오류",
          "studio.conn.connected": "연결됨",
          "studio.conn.reconnecting": "재연결 중...",
          "studio.conn.updated": "업데이트됨",
          "studio.conn.refreshFailed": "새로고침 실패",
          "studio.conn.starting": "작업 시작 중...",
          "studio.conn.live": "실시간",
          "studio.conn.manual": "수동",
          "studio.conn.restore": "복원",
          "studio.conn.error": "오류",
          "studio.msg.reconnected": "기존 작업에 다시 연결됨: ",
          "studio.msg.startPrompt": "왼쪽 Command Chat에 목표를 입력하고 Send를 누르세요.",
          "studio.msg.taskStarted": "작업 시작: ",
          "studio.msg.goal": "목표: ",
          "studio.msg.errorPrefix": "오류: "
        }
      };

      function t(key) {
        const table = i18n[currentLang] || i18n.en;
        return table[key] || i18n.en[key] || key;
      }

      function connText(reason) {
        if (!reason) return t("studio.conn.updated");
        return t("studio.conn." + reason) || reason;
      }

      function applyLocale() {
        setText("studioLblTask", t("studio.label.task"));
        setText("studioLblStatus", t("studio.label.status"));
        setText("studioLblStage", t("studio.label.stage"));
        setText("studioLblApi", t("studio.label.api"));
        setText("studioLblOpenAI", t("studio.label.openai"));
        setText("studioLblAnthropic", t("studio.label.anthropic"));
        setText("studioLblGemini", t("studio.label.gemini"));
        setText("studioLblWriter", t("studio.label.writer"));
        setText("studioLblConn", t("studio.label.conn"));
        setText("studioLblTurns", t("studio.label.turns"));
        setText("studioLblVerify", t("studio.label.verify"));
        setText("studioLblError", t("studio.label.error"));
        setText("refreshTaskBtn", t("studio.button.refreshTask"));
        setText("showLogBtn", t("studio.button.openLog"));
        setText("sendBtn", t("studio.button.send"));
        setText("approveBtn", t("studio.button.approve"));
        setText("rejectBtn", t("studio.button.reject"));
        setText("retryBtn", t("studio.button.retry"));
        setText("studioCommandChatTitle", t("studio.title.commandChat"));
        setText("studioDebateLiveTitle", t("studio.title.debateLive"));
        setText("studioEventLogTitle", t("studio.title.eventLog"));
        setText("studioLayoutHint", t("studio.meta.layout"));

        const langButton = byId("studioLangToggleBtn");
        if (langButton) {
          langButton.textContent = currentLang === "en" ? "KO" : "EN";
        }

        document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
          const key = element.getAttribute("data-i18n-placeholder");
          if (!key || !("placeholder" in element)) return;
          element.placeholder = t(key);
        });

        const taskStatusEl = byId("taskStatus");
        if (taskStatusEl && (taskStatusEl.textContent === "idle" || taskStatusEl.textContent === "대기")) {
          taskStatusEl.textContent = t("studio.status.idle");
        }
        const verifyStateEl = byId("verifyState");
        if (verifyStateEl && (verifyStateEl.textContent === "none" || verifyStateEl.textContent === "없음")) {
          verifyStateEl.textContent = t("studio.status.none");
        }
        const connectionStateEl = byId("connectionState");
        if (connectionStateEl && (connectionStateEl.textContent === "idle" || connectionStateEl.textContent === "대기")) {
          connectionStateEl.textContent = t("studio.status.idle");
        }
      }

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
        author.textContent = (role === "user" ? t("studio.author.you") : t("studio.author.hub")) + " - " + nowTime();

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
          empty.textContent = t("studio.turns.empty");
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
          : t("studio.status.none");
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
          setText("connectionState", connText(reason));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setText("connectionState", t("studio.conn.refreshFailed"));
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
        setText("connectionState", t("studio.conn.connected"));

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
          setText("connectionState", t("studio.conn.reconnecting"));
        };
      }

      function setRuntimeStatus() {
        setText("apiUrl", state.orchestratorUrl || "-");
        setText("openAIStatus", state.runtime && state.runtime.openAIApiKeyConfigured ? t("studio.status.configured") : t("studio.status.notSet"));
        setText("anthropicStatus", state.runtime && state.runtime.anthropicApiKeyConfigured ? t("studio.status.configured") : t("studio.status.notSet"));
        setText("geminiStatus", state.runtime && state.runtime.geminiApiKeyConfigured ? t("studio.status.configured") : t("studio.status.notSet"));
        setText("driverStatus", state.runtime && state.runtime.driverAgentId ? state.runtime.driverAgentId : t("studio.status.auto"));
      }

      function onStart() {
        const goalInput = byId("goalInput");
        const goal = goalInput && goalInput.value ? goalInput.value.trim() : "";
        if (!goal) {
          addEvent("warn", t("studio.warn.goalEmpty"));
          return;
        }
        addChat("user", goal);
        if (goalInput) goalInput.value = "";
        setText("connectionState", t("studio.conn.starting"));
        vscode.postMessage({ command: "startTask", userGoal: goal });
      }

      function onDecision(action) {
        if (!state.taskId) {
          addEvent("warn", t("studio.warn.noTask"));
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
            addChat("assistant", t("studio.msg.taskStarted") + state.taskId + (goal ? "\\n" + t("studio.msg.goal") + goal : ""));
          }
          return;
        }

        if (msg.type === "error") {
          const text = msg.message || t("studio.error.unknown");
          addChat("assistant", t("studio.msg.errorPrefix") + text);
          addEvent("error", text);
          setText("connectionState", t("studio.conn.error"));
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
      const studioLangToggleBtn = byId("studioLangToggleBtn");
      if (studioLangToggleBtn) {
        studioLangToggleBtn.addEventListener("click", () => {
          currentLang = currentLang === "en" ? "ko" : "en";
          try {
            localStorage.setItem(studioLangStorageKey, currentLang);
          } catch {}
          applyLocale();
          setRuntimeStatus();
          if (state.bundle) {
            renderBundle(state.bundle);
          }
        });
      }

      window.addEventListener("beforeunload", () => {
        disconnectEvents();
      });

      applyLocale();
      setRuntimeStatus();
      if (state.taskId) {
        addChat("assistant", t("studio.msg.reconnected") + state.taskId);
        refreshTask("restore").then(() => connectEvents());
      } else {
        addChat("assistant", t("studio.msg.startPrompt"));
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


