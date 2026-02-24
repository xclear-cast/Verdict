import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { VerificationResult, VerificationPolicy } from "@agent-hub/shared";

function nowIso(): string {
  return new Date().toISOString();
}

function hasAnyFile(workspacePath: string, candidates: string[]): boolean {
  return candidates.some((candidate) => fs.existsSync(path.join(workspacePath, candidate)));
}

export function detectVerificationCommands(
  workspacePath: string,
  policy: VerificationPolicy
): { commands: string[]; hadTestCommand: boolean } {
  const allowlist = policy.commandAllowlist;
  const selected: string[] = [];

  if (hasAnyFile(workspacePath, ["package.json"])) {
    const preferred = allowlist.find((command) =>
      ["npm test", "pnpm test", "vitest", "jest"].includes(command.trim())
    );
    if (preferred) selected.push(preferred);
  }

  if (hasAnyFile(workspacePath, ["pyproject.toml", "setup.py", "requirements.txt", "pytest.ini", "tests"])) {
    const pytest = allowlist.find((command) => command.trim().startsWith("pytest"));
    if (pytest && !selected.includes(pytest)) selected.push(pytest);
  }

  return {
    commands: selected,
    hadTestCommand: selected.length > 0
  };
}

function runShellCommand(command: string, workspacePath: string): Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd: workspacePath,
      shell: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        command,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started
      });
    });
  });
}

export async function runVerification(
  taskId: string,
  workspacePath: string,
  policy: VerificationPolicy
): Promise<VerificationResult> {
  const detection = detectVerificationCommands(workspacePath, policy);
  if (policy.requireAtLeastOneTestCommand && !detection.hadTestCommand) {
    return {
      taskId,
      stage: "verify",
      commands: [],
      outputs: [],
      passed: false,
      failures: ["NO_TEST_COMMAND_DETECTED"],
      hadTestCommand: false,
      timestamp: nowIso()
    };
  }

  const outputs = [];
  for (const command of detection.commands) {
    const result = await runShellCommand(command, workspacePath);
    outputs.push(result);
  }

  const failures = outputs
    .filter((result) => result.exitCode !== 0)
    .map((result) => `${result.command} failed with exitCode ${result.exitCode}`);

  return {
    taskId,
    stage: "verify",
    commands: detection.commands,
    outputs,
    passed: failures.length === 0,
    failures,
    hadTestCommand: detection.hadTestCommand,
    timestamp: nowIso()
  };
}
