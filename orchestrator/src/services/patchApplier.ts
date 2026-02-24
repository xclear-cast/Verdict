import fs from "node:fs";
import path from "node:path";
import DiffMatchPatch from "diff-match-patch";
import type { EditOperation } from "@agent-hub/shared";

export interface PatchApplyResult {
  success: boolean;
  appliedCount: number;
  errors: string[];
}

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function normalizeLooseLine(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function orderedMatchRatio(candidate: string[], target: string[]): number {
  if (target.length === 0) return 0;
  let cursor = 0;
  let matched = 0;
  for (const line of target) {
    while (cursor < candidate.length && candidate[cursor] !== line) {
      cursor += 1;
    }
    if (cursor >= candidate.length) break;
    matched += 1;
    cursor += 1;
  }
  return matched / target.length;
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
  const findLines = normalizedFind.split("\n");
  if (findLines.length === 0) return null;

  for (let i = 0; i <= contentLines.length - findLines.length; i += 1) {
    const candidate = contentLines.slice(i, i + findLines.length).map((line) => normalizeLooseLine(line));
    const isMatch = candidate.every((line, index) => line === normalizeLooseLine(findLines[index]));
    if (!isMatch) continue;
    const replacementLines = normalize(replace).split("\n");
    const merged = [...contentLines.slice(0, i), ...replacementLines, ...contentLines.slice(i + findLines.length)];
    return merged.join("\n");
  }

  const compactFindLines = findLines.map((line) => normalizeLooseLine(line)).filter((line) => line.length > 0);
  if (compactFindLines.length > 0) {
    const firstAnchor = compactFindLines[0];
    const lastAnchor = compactFindLines[compactFindLines.length - 1];
    const normalizedContentLines = contentLines.map((line) => normalizeLooseLine(line));
    const candidateWindow = compactFindLines.length + 14;
    const replacementLines = normalize(replace).split("\n");

    for (let start = 0; start < normalizedContentLines.length; start += 1) {
      if (normalizedContentLines[start] !== firstAnchor) continue;
      const maxEnd = Math.min(normalizedContentLines.length - 1, start + candidateWindow);
      for (let end = start; end <= maxEnd; end += 1) {
        if (normalizedContentLines[end] !== lastAnchor) continue;
        const chunk = normalizedContentLines.slice(start, end + 1).filter((line) => line.length > 0);
        const ratio = orderedMatchRatio(chunk, compactFindLines);
        if (ratio < 0.75) continue;
        return [...contentLines.slice(0, start), ...replacementLines, ...contentLines.slice(end + 1)].join("\n");
      }
    }
  }

  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = 0.45;
  dmp.Match_Distance = Math.max(normalizedContent.length, 2000);
  dmp.Patch_DeleteThreshold = 0.6;

  const patches = dmp.patch_make(normalizedFind, normalize(replace));
  if (patches.length > 0) {
    const [patched, applied] = dmp.patch_apply(patches, normalizedContent);
    if (applied.some(Boolean)) {
      return patched;
    }
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
