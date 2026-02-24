import { z } from "zod";
import { STAGES } from "./types.js";

export const stageSchema = z.enum(STAGES);
export const verdictSchema = z.enum(["approve", "revise", "reject"]);
export const consensusModeSchema = z.enum(["unanimous", "quorum", "judge"]);
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "needs_human_decision",
  "completed",
  "failed",
  "stopped_budget"
]);

export const agentRoleSchema = z.enum(["driver", "reviewer", "judge", "general"]);

export const focusContextSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
});

const editOpBaseSchema = z.object({
  path: z.string().min(1)
});

export const createOperationSchema = editOpBaseSchema.extend({
  op: z.literal("create"),
  content: z.string()
});

export const deleteOperationSchema = editOpBaseSchema.extend({
  op: z.literal("delete")
});

export const replaceOperationSchema = editOpBaseSchema.extend({
  op: z.literal("replace"),
  find: z.string(),
  replace: z.string()
});

export const appendOperationSchema = editOpBaseSchema.extend({
  op: z.literal("append"),
  content: z.string()
});

export const rewriteOperationSchema = editOpBaseSchema.extend({
  op: z.literal("rewrite"),
  content: z.string()
});

export const editOperationSchema = z.discriminatedUnion("op", [
  createOperationSchema,
  deleteOperationSchema,
  replaceOperationSchema,
  appendOperationSchema,
  rewriteOperationSchema
]);

export const patchProposalSchema = z.object({
  taskId: z.string().min(1),
  stage: z.literal("patch"),
  summary: z.string().min(1),
  unifiedDiff: z.string().optional(),
  touchedFiles: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  editOperations: z.array(editOperationSchema).min(1)
});

export const debateTurnSchema = z.object({
  taskId: z.string().min(1),
  stage: stageSchema,
  round: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  agentId: z.string().min(1),
  provider: z.string().min(1),
  message: z.string().min(1),
  verdict: verdictSchema,
  risks: z.array(z.string()),
  focusContext: focusContextSchema.optional(),
  patchProposal: patchProposalSchema.optional(),
  timestamp: z.string().datetime()
});

export const verificationResultSchema = z.object({
  taskId: z.string().min(1),
  stage: z.literal("verify"),
  commands: z.array(z.string()),
  outputs: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number().int().nonnegative()
    })
  ),
  passed: z.boolean(),
  failures: z.array(z.string()),
  hadTestCommand: z.boolean(),
  timestamp: z.string().datetime()
});

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  role: agentRoleSchema.default("general"),
  model: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  costPerCallUsd: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.string()).optional()
});

export const debatePolicySchema = z.object({
  maxDebateRounds: z.number().int().min(1).max(5).default(2),
  maxRetriesPerStage: z.number().int().min(0).max(5).default(2),
  consensusMode: consensusModeSchema.default("unanimous"),
  quorumRatio: z.number().min(0.5).max(1).default(1),
  criticalOnlyInFinalRound: z.boolean().default(true)
});

export const budgetLimitsSchema = z.object({
  maxStageExecutions: z.number().int().min(1).default(5),
  maxModelCallsPerStage: z.number().int().min(1).default(4),
  maxModelCallsPerTask: z.number().int().min(1).default(40),
  maxCostUsd: z.number().positive().default(1)
});

export const protectionPolicySchema = z.object({
  protectedPathPatterns: z.array(z.string()).default([]),
  protectedTestPathPatterns: z.array(z.string()).default([]),
  allowTestChangesWithApproval: z.boolean().default(false)
});

export const verificationPolicySchema = z.object({
  commandAllowlist: z.array(z.string()).default(["npm test", "pnpm test", "pytest", "vitest", "jest"]),
  requireAtLeastOneTestCommand: z.boolean().default(true),
  autoApplyOnTestPass: z.boolean().default(true)
});

export const taskRequestSchema = z.object({
  workspacePath: z.string().min(1),
  userGoal: z.string().min(1),
  agents: z.array(agentConfigSchema).min(2),
  driverAgentId: z.string().min(1).max(120).optional(),
  debatePolicy: debatePolicySchema,
  budgetLimits: budgetLimitsSchema,
  protectionPolicy: protectionPolicySchema,
  verificationPolicy: verificationPolicySchema
});

export const taskDecisionRequestSchema = z.object({
  action: z.enum(["approve_patch", "reject_patch", "retry_step", "stop_task"]),
  note: z.string().max(3000).optional()
});

export const providerResponseSchema = z.object({
  message: z.string().min(1),
  verdict: verdictSchema,
  risks: z.array(z.string()).default([]),
  focusContext: focusContextSchema.optional(),
  patchProposal: patchProposalSchema.optional()
});

export type ProviderResponsePayload = z.infer<typeof providerResponseSchema>;
