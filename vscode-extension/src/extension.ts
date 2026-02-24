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

function getOrchestratorUrl(): string {
  const config = vscode.workspace.getConfiguration("multiAgent");
  return String(config.get("orchestratorUrl", "http://127.0.0.1:3939")).replace(/\/+$/, "");
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

function renderDebateHtml(bundle: TaskBundle): string {
  const rows = bundle.turns
    .map(
      (turn) => `
      <tr>
        <td>${turn.stage}</td>
        <td>${turn.attempt}</td>
        <td>${turn.round}</td>
        <td>${turn.agentId}</td>
        <td>${turn.provider}</td>
        <td>${turn.verdict}</td>
        <td>${turn.message.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</td>
      </tr>`
    )
    .join("");

  const verification = bundle.latestVerification
    ? `<p><b>Verification:</b> ${bundle.latestVerification.passed ? "PASS" : "FAIL"} ${
        bundle.latestVerification.failures.join(", ") || ""
      }</p>`
    : "<p><b>Verification:</b> none</p>";

  const patch = bundle.latestPatch
    ? `<p><b>Latest Patch:</b> ${bundle.latestPatch.summary} (confidence: ${bundle.latestPatch.confidence})</p>
       <p><b>Touched:</b> ${bundle.latestPatch.touchedFiles.join(", ")}</p>`
    : "<p><b>Latest Patch:</b> none</p>";

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Segoe UI, sans-serif; padding: 16px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f5f5f5; }
      code { background: #f0f0f0; padding: 2px 4px; }
    </style>
  </head>
  <body>
    <h2>Task ${bundle.task.id}</h2>
    <p><b>Status:</b> ${bundle.task.status}</p>
    <p><b>Current Stage:</b> ${bundle.task.currentStage}</p>
    ${bundle.task.lastError ? `<p><b>Last Error:</b> ${bundle.task.lastError}</p>` : ""}
    ${verification}
    ${patch}
    <h3>Debate Turns</h3>
    <table>
      <thead>
        <tr>
          <th>Stage</th><th>Attempt</th><th>Round</th><th>Agent</th><th>Provider</th><th>Verdict</th><th>Message</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
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
      const url = `${getOrchestratorUrl()}/tasks/${taskId}`;
      try {
        const bundle = await fetchJson<TaskBundle>(url);
        const panel = vscode.window.createWebviewPanel(
          "multiAgentDebateLog",
          `Debate Log: ${taskId}`,
          vscode.ViewColumn.Two,
          { enableScripts: false }
        );
        panel.webview.html = renderDebateHtml(bundle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Load log failed: ${message}`);
      }
    })
  );
}

export function deactivate() {}
