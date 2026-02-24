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
  criticalOnlyInFinalRound: true,
  enableUnanimousAutoFullAccess: true
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
  allowTestChangesWithApproval: false,
  allowPathEscape: false
};

const defaultVerificationPolicy: VerificationPolicy = {
  commandAllowlist: ["npm test", "pnpm test", "pytest", "vitest", "jest"],
  requireAtLeastOneTestCommand: true,
  autoApplyOnTestPass: true
};

function parseIntEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (typeof min === "number" && intValue < min) return fallback;
  if (typeof max === "number" && intValue > max) return fallback;
  return intValue;
}

function parseNumberEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (typeof min === "number" && value < min) return fallback;
  if (typeof max === "number" && value > max) return fallback;
  return value;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

function parseConsensusModeEnv(name: string, fallback: DebatePolicy["consensusMode"]): DebatePolicy["consensusMode"] {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === "unanimous" || raw === "quorum" || raw === "judge") return raw;
  return fallback;
}

function resolveDebatePolicyDefaults(): DebatePolicy {
  return {
    maxDebateRounds: parseIntEnv("AGENT_HUB_MAX_DEBATE_ROUNDS", defaultDebatePolicy.maxDebateRounds, 1, 5),
    maxRetriesPerStage: parseIntEnv("AGENT_HUB_MAX_RETRIES_PER_STAGE", defaultDebatePolicy.maxRetriesPerStage, 0, 10),
    consensusMode: parseConsensusModeEnv("AGENT_HUB_CONSENSUS_MODE", defaultDebatePolicy.consensusMode),
    quorumRatio: parseNumberEnv("AGENT_HUB_QUORUM_RATIO", defaultDebatePolicy.quorumRatio, 0.5, 1),
    criticalOnlyInFinalRound: parseBooleanEnv(
      "AGENT_HUB_CRITICAL_ONLY_IN_FINAL_ROUND",
      defaultDebatePolicy.criticalOnlyInFinalRound
    ),
    enableUnanimousAutoFullAccess: parseBooleanEnv(
      "AGENT_HUB_ENABLE_UNANIMOUS_AUTO_FULL_ACCESS",
      defaultDebatePolicy.enableUnanimousAutoFullAccess
    )
  };
}

function resolveBudgetLimitDefaults(): BudgetLimits {
  return {
    maxStageExecutions: parseIntEnv("AGENT_HUB_MAX_STAGE_EXECUTIONS", defaultBudgetLimits.maxStageExecutions, 1, 20),
    maxModelCallsPerStage: parseIntEnv(
      "AGENT_HUB_MAX_MODEL_CALLS_PER_STAGE",
      defaultBudgetLimits.maxModelCallsPerStage,
      1,
      200
    ),
    maxModelCallsPerTask: parseIntEnv(
      "AGENT_HUB_MAX_MODEL_CALLS_PER_TASK",
      defaultBudgetLimits.maxModelCallsPerTask,
      1,
      2000
    ),
    maxCostUsd: parseNumberEnv("AGENT_HUB_MAX_COST_USD", defaultBudgetLimits.maxCostUsd, 0.01, 1000)
  };
}

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
  settingsPath: string;
  modelTimeoutMs: number;
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
  settingsPath: process.env.AGENT_HUB_SETTINGS_PATH ?? path.resolve(path.dirname(resolvedSchemaPath), "runtime_settings.json"),
  modelTimeoutMs: Number(process.env.AGENT_HUB_MODEL_TIMEOUT_MS ?? 30000),
  defaultDebatePolicy,
  defaultBudgetLimits,
  defaultProtectionPolicy,
  defaultVerificationPolicy
};

export function getDefaultAgents(): AgentConfig[] {
  try {
    return parseAgentsFromEnv();
  } catch {
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
}

export function withDefaultTaskOptions(input: Partial<TaskRequest>): TaskRequest {
  const configuredDriverAgentId = process.env.AGENT_HUB_DRIVER_AGENT_ID?.trim();
  const requestDriverAgentId = input.driverAgentId?.trim();
  const debateDefaults = resolveDebatePolicyDefaults();
  const budgetDefaults = resolveBudgetLimitDefaults();
  return {
    workspacePath: input.workspacePath ?? "",
    userGoal: input.userGoal ?? "",
    agents: input.agents?.length ? input.agents : getDefaultAgents(),
    driverAgentId: requestDriverAgentId || configuredDriverAgentId || undefined,
    debatePolicy: { ...debateDefaults, ...(input.debatePolicy ?? {}) },
    budgetLimits: { ...budgetDefaults, ...(input.budgetLimits ?? {}) },
    protectionPolicy: { ...runtimeConfig.defaultProtectionPolicy, ...(input.protectionPolicy ?? {}) },
    verificationPolicy: {
      ...runtimeConfig.defaultVerificationPolicy,
      ...(input.verificationPolicy ?? {})
    }
  };
}
