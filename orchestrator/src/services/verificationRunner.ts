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

interface ParsedCommand {
  raw: string;
  baseCommand: string;
  executable: string;
  args: string[];
  normalized: string;
}

const FORBIDDEN_SHELL_TOKENS = /[|&;<>()`$]/;

function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match: RegExpExecArray | null = regex.exec(raw);
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
    match = regex.exec(raw);
  }
  return tokens;
}

function parseAllowlistCommand(rawCommand: string): ParsedCommand | null {
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;
  if (FORBIDDEN_SHELL_TOKENS.test(trimmed)) return null;

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => FORBIDDEN_SHELL_TOKENS.test(token))) {
    return null;
  }

  const [command, ...args] = tokens;
  return {
    raw: trimmed,
    baseCommand: command,
    executable: command,
    args,
    normalized: tokens.map((token) => token.toLowerCase()).join(" ")
  };
}

function parseAllowlist(policy: VerificationPolicy): ParsedCommand[] {
  const parsed: ParsedCommand[] = [];
  const seen = new Set<string>();
  for (const command of policy.commandAllowlist) {
    const entry = parseAllowlistCommand(command);
    if (!entry) continue;
    if (seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    parsed.push(entry);
  }
  return parsed;
}

function detectVerificationCommandsInternal(
  workspacePath: string,
  policy: VerificationPolicy
): { parsedCommands: ParsedCommand[]; commands: string[]; hadTestCommand: boolean } {
  const allowlist = parseAllowlist(policy);
  const selected: string[] = [];
  const selectedEntries: ParsedCommand[] = [];

  if (hasAnyFile(workspacePath, ["package.json"])) {
    const preferred = allowlist.find((command) =>
      ["npm test", "pnpm test", "vitest", "jest", "npx vitest", "npx jest"].some(
        (candidate) => command.normalized === candidate || command.normalized.startsWith(`${candidate} `)
      )
    );
    if (preferred) {
      selected.push(preferred.raw);
      selectedEntries.push(preferred);
    }
  }

  if (hasAnyFile(workspacePath, ["pyproject.toml", "setup.py", "requirements.txt", "pytest.ini", "tests"])) {
    const pytest = allowlist.find(
      (command) =>
        command.normalized === "pytest" ||
        command.normalized.startsWith("pytest ") ||
        command.normalized === "python -m pytest" ||
        command.normalized.startsWith("python -m pytest ")
    );
    if (pytest && !selected.includes(pytest.raw)) {
      selected.push(pytest.raw);
      selectedEntries.push(pytest);
    }
  }

  return {
    parsedCommands: selectedEntries,
    commands: selected,
    hadTestCommand: selected.length > 0
  };
}

export function detectVerificationCommands(
  workspacePath: string,
  policy: VerificationPolicy
): { commands: string[]; hadTestCommand: boolean } {
  const detection = detectVerificationCommandsInternal(workspacePath, policy);
  return {
    commands: detection.commands,
    hadTestCommand: detection.hadTestCommand
  };
}

function runProcessCommand(command: ParsedCommand, workspacePath: string): Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  return new Promise((resolve) => {
    const lowerBase = command.baseCommand.toLowerCase();
    const useCmdWrapper =
      process.platform === "win32" && ["npm", "pnpm", "npx", "yarn"].includes(lowerBase);

    const quoteForCmd = (token: string) => {
      const escaped = token.replaceAll("\"", "\"\"");
      return /[\s"]/g.test(escaped) ? `"${escaped}"` : escaped;
    };

    const executable = useCmdWrapper ? process.env.ComSpec ?? "cmd.exe" : command.executable;
    const args = useCmdWrapper
      ? ["/d", "/s", "/c", [`${command.baseCommand}.cmd`, ...command.args].map(quoteForCmd).join(" ")]
      : command.args;

    const started = Date.now();
    const child = spawn(executable, args, {
      cwd: workspacePath,
      shell: false,
      windowsHide: true
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
        command: command.raw,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started
      });
    });
    child.on("error", (error) => {
      resolve({
        command: command.raw,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\nSPAWN_ERROR:${error instanceof Error ? error.message : String(error)}`,
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
  const detection = detectVerificationCommandsInternal(workspacePath, policy);
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
  for (const command of detection.parsedCommands) {
    const result = await runProcessCommand(command, workspacePath);
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
