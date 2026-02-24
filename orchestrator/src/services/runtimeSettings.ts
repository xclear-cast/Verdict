import fs from "node:fs";
import path from "node:path";

type ConsensusMode = "unanimous" | "quorum" | "judge";

export interface RuntimeSettingsPayload {
  openAIApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  agentsJson?: string;
  driverAgentId?: string;
  maxDebateRounds?: number;
  maxRetriesPerStage?: number;
  consensusMode?: ConsensusMode;
  quorumRatio?: number;
  criticalOnlyInFinalRound?: boolean;
  maxStageExecutions?: number;
  maxModelCallsPerStage?: number;
  maxModelCallsPerTask?: number;
  maxCostUsd?: number;
}

export interface RuntimeSettingsSummary {
  openAIApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  geminiApiKeyConfigured: boolean;
  agentsJsonConfigured: boolean;
  driverAgentId?: string;
  maxDebateRounds?: number;
  maxRetriesPerStage?: number;
  consensusMode?: ConsensusMode;
  quorumRatio?: number;
  criticalOnlyInFinalRound?: boolean;
  maxStageExecutions?: number;
  maxModelCallsPerStage?: number;
  maxModelCallsPerTask?: number;
  maxCostUsd?: number;
  updatedAt?: string;
}

interface PersistedRuntimeSettings extends RuntimeSettingsPayload {
  updatedAt?: string;
}

function cleanValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function cleanBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") return true;
    if (trimmed === "false" || trimmed === "0") return false;
  }
  return undefined;
}

function cleanConsensusMode(value: unknown): ConsensusMode | undefined {
  if (value === "unanimous" || value === "quorum" || value === "judge") {
    return value;
  }
  return undefined;
}

export class RuntimeSettingsService {
  private cache: PersistedRuntimeSettings = {};

  constructor(private readonly filePath: string) {}

  initialize(): void {
    this.cache = this.readFromDisk();
    this.applyToProcess(this.cache);
  }

  getSummary(): RuntimeSettingsSummary {
    return {
      openAIApiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      anthropicApiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      geminiApiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
      agentsJsonConfigured: Boolean(process.env.AGENT_HUB_AGENTS_JSON),
      driverAgentId: process.env.AGENT_HUB_DRIVER_AGENT_ID || undefined,
      maxDebateRounds: cleanNumber(process.env.AGENT_HUB_MAX_DEBATE_ROUNDS),
      maxRetriesPerStage: cleanNumber(process.env.AGENT_HUB_MAX_RETRIES_PER_STAGE),
      consensusMode: cleanConsensusMode(process.env.AGENT_HUB_CONSENSUS_MODE),
      quorumRatio: cleanNumber(process.env.AGENT_HUB_QUORUM_RATIO),
      criticalOnlyInFinalRound: cleanBoolean(process.env.AGENT_HUB_CRITICAL_ONLY_IN_FINAL_ROUND),
      maxStageExecutions: cleanNumber(process.env.AGENT_HUB_MAX_STAGE_EXECUTIONS),
      maxModelCallsPerStage: cleanNumber(process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_STAGE),
      maxModelCallsPerTask: cleanNumber(process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_TASK),
      maxCostUsd: cleanNumber(process.env.AGENT_HUB_MAX_COST_USD),
      updatedAt: this.cache.updatedAt
    };
  }

  update(payload: RuntimeSettingsPayload): RuntimeSettingsSummary {
    const next: PersistedRuntimeSettings = {
      openAIApiKey: cleanValue(payload.openAIApiKey) ?? this.cache.openAIApiKey,
      anthropicApiKey: cleanValue(payload.anthropicApiKey) ?? this.cache.anthropicApiKey,
      geminiApiKey: cleanValue(payload.geminiApiKey) ?? this.cache.geminiApiKey,
      agentsJson: cleanValue(payload.agentsJson) ?? this.cache.agentsJson,
      driverAgentId: cleanValue(payload.driverAgentId) ?? this.cache.driverAgentId,
      maxDebateRounds: cleanNumber(payload.maxDebateRounds) ?? this.cache.maxDebateRounds,
      maxRetriesPerStage: cleanNumber(payload.maxRetriesPerStage) ?? this.cache.maxRetriesPerStage,
      consensusMode: cleanConsensusMode(payload.consensusMode) ?? this.cache.consensusMode,
      quorumRatio: cleanNumber(payload.quorumRatio) ?? this.cache.quorumRatio,
      criticalOnlyInFinalRound: cleanBoolean(payload.criticalOnlyInFinalRound) ?? this.cache.criticalOnlyInFinalRound,
      maxStageExecutions: cleanNumber(payload.maxStageExecutions) ?? this.cache.maxStageExecutions,
      maxModelCallsPerStage: cleanNumber(payload.maxModelCallsPerStage) ?? this.cache.maxModelCallsPerStage,
      maxModelCallsPerTask: cleanNumber(payload.maxModelCallsPerTask) ?? this.cache.maxModelCallsPerTask,
      maxCostUsd: cleanNumber(payload.maxCostUsd) ?? this.cache.maxCostUsd,
      updatedAt: new Date().toISOString()
    };

    if (payload.openAIApiKey !== undefined && !cleanValue(payload.openAIApiKey)) {
      delete next.openAIApiKey;
    }
    if (payload.anthropicApiKey !== undefined && !cleanValue(payload.anthropicApiKey)) {
      delete next.anthropicApiKey;
    }
    if (payload.geminiApiKey !== undefined && !cleanValue(payload.geminiApiKey)) {
      delete next.geminiApiKey;
    }
    if (payload.agentsJson !== undefined && !cleanValue(payload.agentsJson)) {
      delete next.agentsJson;
    }
    if (payload.driverAgentId !== undefined && !cleanValue(payload.driverAgentId)) {
      delete next.driverAgentId;
    }

    this.cache = next;
    this.writeToDisk(next);
    this.applyToProcess(next);
    return this.getSummary();
  }

  private applyToProcess(settings: PersistedRuntimeSettings): void {
    if (settings.openAIApiKey) {
      process.env.OPENAI_API_KEY = settings.openAIApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    if (settings.anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }

    if (settings.geminiApiKey) {
      process.env.GEMINI_API_KEY = settings.geminiApiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }

    if (settings.agentsJson) {
      process.env.AGENT_HUB_AGENTS_JSON = settings.agentsJson;
    } else {
      delete process.env.AGENT_HUB_AGENTS_JSON;
    }

    if (settings.driverAgentId) {
      process.env.AGENT_HUB_DRIVER_AGENT_ID = settings.driverAgentId;
    } else {
      delete process.env.AGENT_HUB_DRIVER_AGENT_ID;
    }

    if (typeof settings.maxDebateRounds === "number") {
      process.env.AGENT_HUB_MAX_DEBATE_ROUNDS = String(settings.maxDebateRounds);
    } else {
      delete process.env.AGENT_HUB_MAX_DEBATE_ROUNDS;
    }

    if (typeof settings.maxRetriesPerStage === "number") {
      process.env.AGENT_HUB_MAX_RETRIES_PER_STAGE = String(settings.maxRetriesPerStage);
    } else {
      delete process.env.AGENT_HUB_MAX_RETRIES_PER_STAGE;
    }

    if (settings.consensusMode) {
      process.env.AGENT_HUB_CONSENSUS_MODE = settings.consensusMode;
    } else {
      delete process.env.AGENT_HUB_CONSENSUS_MODE;
    }

    if (typeof settings.quorumRatio === "number") {
      process.env.AGENT_HUB_QUORUM_RATIO = String(settings.quorumRatio);
    } else {
      delete process.env.AGENT_HUB_QUORUM_RATIO;
    }

    if (typeof settings.criticalOnlyInFinalRound === "boolean") {
      process.env.AGENT_HUB_CRITICAL_ONLY_IN_FINAL_ROUND = settings.criticalOnlyInFinalRound ? "true" : "false";
    } else {
      delete process.env.AGENT_HUB_CRITICAL_ONLY_IN_FINAL_ROUND;
    }

    if (typeof settings.maxStageExecutions === "number") {
      process.env.AGENT_HUB_MAX_STAGE_EXECUTIONS = String(settings.maxStageExecutions);
    } else {
      delete process.env.AGENT_HUB_MAX_STAGE_EXECUTIONS;
    }

    if (typeof settings.maxModelCallsPerStage === "number") {
      process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_STAGE = String(settings.maxModelCallsPerStage);
    } else {
      delete process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_STAGE;
    }

    if (typeof settings.maxModelCallsPerTask === "number") {
      process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_TASK = String(settings.maxModelCallsPerTask);
    } else {
      delete process.env.AGENT_HUB_MAX_MODEL_CALLS_PER_TASK;
    }

    if (typeof settings.maxCostUsd === "number") {
      process.env.AGENT_HUB_MAX_COST_USD = String(settings.maxCostUsd);
    } else {
      delete process.env.AGENT_HUB_MAX_COST_USD;
    }
  }

  private readFromDisk(): PersistedRuntimeSettings {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedRuntimeSettings;
      return {
        openAIApiKey: cleanValue(parsed.openAIApiKey),
        anthropicApiKey: cleanValue(parsed.anthropicApiKey),
        geminiApiKey: cleanValue(parsed.geminiApiKey),
        agentsJson: cleanValue(parsed.agentsJson),
        driverAgentId: cleanValue(parsed.driverAgentId),
        maxDebateRounds: cleanNumber(parsed.maxDebateRounds),
        maxRetriesPerStage: cleanNumber(parsed.maxRetriesPerStage),
        consensusMode: cleanConsensusMode(parsed.consensusMode),
        quorumRatio: cleanNumber(parsed.quorumRatio),
        criticalOnlyInFinalRound: cleanBoolean(parsed.criticalOnlyInFinalRound),
        maxStageExecutions: cleanNumber(parsed.maxStageExecutions),
        maxModelCallsPerStage: cleanNumber(parsed.maxModelCallsPerStage),
        maxModelCallsPerTask: cleanNumber(parsed.maxModelCallsPerTask),
        maxCostUsd: cleanNumber(parsed.maxCostUsd),
        updatedAt: parsed.updatedAt
      };
    } catch {
      return {};
    }
  }

  private writeToDisk(settings: PersistedRuntimeSettings): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(settings, null, 2), "utf8");
  }
}
