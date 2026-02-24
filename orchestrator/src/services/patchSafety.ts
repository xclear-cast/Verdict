import path from "node:path";
import picomatch from "picomatch";
import type { PatchProposal, ProtectionPolicy } from "@agent-hub/shared";

function normalizeForMatch(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function hasPatternMatch(pathValue: string, patterns: string[]): boolean {
  const normalized = normalizeForMatch(pathValue);
  return patterns.some((pattern) => picomatch(pattern)(normalized));
}

export interface PatchSafetyResult {
  blocked: boolean;
  reason?: string;
}

export function evaluatePatchSafety(
  workspacePath: string,
  patch: PatchProposal,
  policy: ProtectionPolicy
): PatchSafetyResult {
  const touched = new Set<string>(patch.touchedFiles);
  for (const operation of patch.editOperations) {
    touched.add(operation.path);
  }

  for (const relativePath of touched) {
    const normalizedRelative = normalizeForMatch(relativePath);
    const absolute = path.resolve(workspacePath, relativePath);
    const normalizedAbsolute = normalizeForMatch(absolute);

    if (!normalizedAbsolute.toLowerCase().startsWith(normalizeForMatch(workspacePath).toLowerCase())) {
      return { blocked: true, reason: `path_escape_blocked:${relativePath}` };
    }

    if (hasPatternMatch(normalizedRelative, policy.protectedPathPatterns)) {
      return { blocked: true, reason: `protected_path_blocked:${relativePath}` };
    }

    if (
      hasPatternMatch(normalizedRelative, policy.protectedTestPathPatterns) &&
      !policy.allowTestChangesWithApproval
    ) {
      return { blocked: true, reason: `test_path_blocked:${relativePath}` };
    }
  }

  return { blocked: false };
}
