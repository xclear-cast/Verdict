import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentConfig,
  BudgetLimits,
  DebatePolicy,
  ProtectionPolicy,
  TaskRequest,
  VerificationPolicy
} from "@agent-hub/shared";

const defaultBudgetLimits: BudgetLimits = {
  maxStageExecutions: 5,
  maxModelCallsPerStage: 4,
  maxModelCallsPerTask: 40,
  maxCostUsd: 1
};

const defaultDebatePolicy: DebatePolicy = {
  maxDebateRounds: 2,
  maxRetriesPerStage: 2,
  consensusMode: "unanimous",
  quorumRatio: 1,
  criticalOnlyInFinalRound: true
};

const defaultProtectionPolicy: ProtectionPolicy = {
  protectedPathPatterns: [
    ".env*",
    "**/.env*",
    "**/secrets/**",
    "**/infra/**",
    "**/.github/workflows/**",
    "**/deploy/**"
  ],
  protectedTestPathPatterns: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
  allowTestChangesWithApproval: false
};

const defaultVerificationPolicy: VerificationPolicy = {
  commandAllowlist: ["npm test", "pnpm test", "pytest", "vitest", "jest"],
  requireAtLeastOneTestCommand: true,
  autoApplyOnTestPass: true
};

function parseAgentsFromEnv(): AgentConfig[] {
  const raw = process.env.AGENT_HUB_AGENTS_JSON;
  if (!raw) {
    return [
      {
        id: "driver-mock",
        provider: "mock",
        role: "driver",
        model: "mock-driver",
        costPerCallUsd: 0.01
      },
      {
        id: "reviewer-mock",
        provider: "mock",
        role: "reviewer",
        model: "mock-reviewer",
        costPerCallUsd: 0.01
      }
    ];
  }
  const parsed = JSON.parse(raw) as AgentConfig[];
  return parsed;
}

export interface RuntimeConfig {
  port: number;
  dbPath: string;
  schemaPath: string;
  modelTimeoutMs: number;
  defaultAgents: AgentConfig[];
  defaultDebatePolicy: DebatePolicy;
  defaultBudgetLimits: BudgetLimits;
  defaultProtectionPolicy: ProtectionPolicy;
  defaultVerificationPolicy: VerificationPolicy;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePathWithFallback(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

const resolvedSchemaPath =
  process.env.AGENT_HUB_SCHEMA_PATH ??
  resolvePathWithFallback(
    [
      path.resolve(__dirname, "../../data/schema.sql"),
      path.resolve(__dirname, "../../../data/schema.sql"),
      path.resolve(process.cwd(), "../data/schema.sql"),
      path.resolve(process.cwd(), "data/schema.sql")
    ],
    path.resolve(process.cwd(), "schema.sql")
  );

export const runtimeConfig: RuntimeConfig = {
  port: Number(process.env.AGENT_HUB_PORT ?? 3939),
  dbPath: process.env.AGENT_HUB_DB_PATH ?? path.resolve(path.dirname(resolvedSchemaPath), "agent_hub.db"),
  schemaPath: resolvedSchemaPath,
  modelTimeoutMs: Number(process.env.AGENT_HUB_MODEL_TIMEOUT_MS ?? 30000),
  defaultAgents: parseAgentsFromEnv(),
  defaultDebatePolicy,
  defaultBudgetLimits,
  defaultProtectionPolicy,
  defaultVerificationPolicy
};

export function withDefaultTaskOptions(input: Partial<TaskRequest>): TaskRequest {
  return {
    workspacePath: input.workspacePath ?? "",
    userGoal: input.userGoal ?? "",
    agents: input.agents?.length ? input.agents : runtimeConfig.defaultAgents,
    debatePolicy: { ...runtimeConfig.defaultDebatePolicy, ...(input.debatePolicy ?? {}) },
    budgetLimits: { ...runtimeConfig.defaultBudgetLimits, ...(input.budgetLimits ?? {}) },
    protectionPolicy: { ...runtimeConfig.defaultProtectionPolicy, ...(input.protectionPolicy ?? {}) },
    verificationPolicy: {
      ...runtimeConfig.defaultVerificationPolicy,
      ...(input.verificationPolicy ?? {})
    }
  };
}
