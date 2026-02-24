import * as vscode from "vscode";

type DecisionAction = "approve_patch" | "reject_patch" | "retry_step";

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

function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.startTask", async () => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        vscode.window.showErrorMessage("Open a workspace folder first.");
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[startTask][error] ${message}`);
        vscode.window.showErrorMessage(`Start failed: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.approvePatch", async () => {
      await postDecision(context, "approve_patch");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.rejectPatch", async () => {
      await postDecision(context, "reject_patch");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("multiAgent.retryStep", async () => {
      await postDecision(context, "retry_step");
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
    })
  );
}

export function deactivate() {}
