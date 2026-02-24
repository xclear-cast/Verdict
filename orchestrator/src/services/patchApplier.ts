import fs from "node:fs";
import path from "node:path";
import type { EditOperation } from "@agent-hub/shared";

export interface PatchApplyResult {
  success: boolean;
  appliedCount: number;
  errors: string[];
}

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function ensureWithinWorkspace(workspacePath: string, targetPath: string): void {
  const root = path.resolve(workspacePath).toLowerCase();
  const resolved = path.resolve(targetPath).toLowerCase();
  if (!resolved.startsWith(root)) {
    throw new Error(`PATH_ESCAPE_BLOCKED:${targetPath}`);
  }
}

function fuzzyReplace(content: string, find: string, replace: string): string | null {
  const normalizedContent = normalize(content);
  const normalizedFind = normalize(find);

  if (normalizedContent.includes(normalizedFind)) {
    return normalizedContent.replace(normalizedFind, normalize(replace));
  }

  const contentLines = normalizedContent.split("\n");
  const findLines = normalizedFind.split("\n").map((line) => line.trim());
  if (findLines.length === 0) return null;

  for (let i = 0; i <= contentLines.length - findLines.length; i += 1) {
    const candidate = contentLines.slice(i, i + findLines.length).map((line) => line.trim());
    const isMatch = candidate.every((line, index) => line === findLines[index]);
    if (!isMatch) continue;
    const replacementLines = normalize(replace).split("\n");
    const merged = [...contentLines.slice(0, i), ...replacementLines, ...contentLines.slice(i + findLines.length)];
    return merged.join("\n");
  }

  return null;
}

function applyOperation(workspacePath: string, operation: EditOperation): void {
  const absolutePath = path.resolve(workspacePath, operation.path);
  ensureWithinWorkspace(workspacePath, absolutePath);

  if (operation.op === "create") {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (fs.existsSync(absolutePath)) {
      throw new Error(`CREATE_TARGET_EXISTS:${operation.path}`);
    }
    fs.writeFileSync(absolutePath, operation.content, "utf8");
    return;
  }

  if (operation.op === "delete") {
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
    return;
  }

  if (operation.op === "append") {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.appendFileSync(absolutePath, operation.content, "utf8");
    return;
  }

  if (operation.op === "rewrite") {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, operation.content, "utf8");
    return;
  }

  const existing = fs.readFileSync(absolutePath, "utf8");
  const replaced = fuzzyReplace(existing, operation.find, operation.replace);
  if (replaced === null) {
    throw new Error(`REPLACE_FIND_NOT_FOUND:${operation.path}`);
  }
  fs.writeFileSync(absolutePath, replaced, "utf8");
}

export function applyEditOperations(workspacePath: string, operations: EditOperation[]): PatchApplyResult {
  let appliedCount = 0;
  const errors: string[] = [];

  for (const operation of operations) {
    try {
      applyOperation(workspacePath, operation);
      appliedCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }

  return {
    success: errors.length === 0,
    appliedCount,
    errors
  };
}
