export const STAGES = ["discover", "plan", "patch", "verify", "finalize"] as const;
export type Stage = (typeof STAGES)[number];

export type AgentRole = "driver" | "reviewer" | "judge" | "general";
export type Verdict = "approve" | "revise" | "reject";
export type TaskStatus =
  | "queued"
  | "running"
  | "needs_human_decision"
  | "completed"
  | "failed"
  | "stopped_budget";

export type ConsensusMode = "unanimous" | "quorum" | "judge";
export type DecisionAction = "approve_patch" | "reject_patch" | "retry_step" | "stop_task";

export interface BudgetLimits {
  maxStageExecutions: number;
  maxModelCallsPerStage: number;
  maxModelCallsPerTask: number;
  maxCostUsd: number;
}

export interface DebatePolicy {
  maxDebateRounds: number;
  maxRetriesPerStage: number;
  consensusMode: ConsensusMode;
  quorumRatio: number;
  criticalOnlyInFinalRound: boolean;
}

export interface ProtectionPolicy {
  protectedPathPatterns: string[];
  protectedTestPathPatterns: string[];
  allowTestChangesWithApproval: boolean;
}

export interface VerificationPolicy {
  commandAllowlist: string[];
  requireAtLeastOneTestCommand: boolean;
  autoApplyOnTestPass: boolean;
}

export interface AgentConfig {
  id: string;
  provider: string;
  role: AgentRole;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  costPerCallUsd?: number;
  metadata?: Record<string, string>;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FocusContext {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface EditOperationBase {
  path: string;
}

export interface CreateFileOperation extends EditOperationBase {
  op: "create";
  content: string;
}

export interface DeleteFileOperation extends EditOperationBase {
  op: "delete";
}

export interface ReplaceInFileOperation extends EditOperationBase {
  op: "replace";
  find: string;
  replace: string;
}

export interface AppendInFileOperation extends EditOperationBase {
  op: "append";
  content: string;
}

export interface RewriteFileOperation extends EditOperationBase {
  op: "rewrite";
  content: string;
}

export type EditOperation =
  | CreateFileOperation
  | DeleteFileOperation
  | ReplaceInFileOperation
  | AppendInFileOperation
  | RewriteFileOperation;

export interface PatchProposal {
  taskId: string;
  stage: "patch";
  summary: string;
  unifiedDiff?: string;
  touchedFiles: string[];
  confidence: number;
  editOperations: EditOperation[];
}

export interface DebateTurn {
  taskId: string;
  stage: Stage;
  round: number;
  attempt: number;
  agentId: string;
  provider: string;
  message: string;
  verdict: Verdict;
  risks: string[];
  focusContext?: FocusContext;
  patchProposal?: PatchProposal;
  timestamp: string;
}

export interface VerificationResult {
  taskId: string;
  stage: "verify";
  commands: string[];
  outputs: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  passed: boolean;
  failures: string[];
  hadTestCommand: boolean;
  timestamp: string;
}

export interface BudgetState {
  taskId: string;
  modelCalls: number;
  stageModelCalls: Record<Stage, number>;
  estimatedCostUsd: number;
  limitExceeded: boolean;
}

export interface TaskRequest {
  workspacePath: string;
  userGoal: string;
  agents: AgentConfig[];
  debatePolicy: DebatePolicy;
  budgetLimits: BudgetLimits;
  protectionPolicy: ProtectionPolicy;
  verificationPolicy: VerificationPolicy;
}

export interface TaskRecord {
  id: string;
  workspacePath: string;
  userGoal: string;
  status: TaskStatus;
  currentStage: Stage;
  currentAttempt: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface TaskSummary extends TaskRecord {
  budget: BudgetState;
}

export interface TaskDecisionRequest {
  action: DecisionAction;
  note?: string;
}

export interface StageResult {
  stage: Stage;
  approved: boolean;
  retryable: boolean;
  reason: string;
  patchProposal?: PatchProposal;
  verification?: VerificationResult;
}

export interface AgentCallContext {
  taskId: string;
  stage: Stage;
  attempt: number;
  round: number;
  workspacePath: string;
  userGoal: string;
  criticalOnly: boolean;
  constraints: string[];
  recentTurns: DebateTurn[];
  latestPatchProposal?: PatchProposal;
  latestVerification?: VerificationResult;
}

export interface AdapterResponse {
  message: string;
  verdict: Verdict;
  risks: string[];
  focusContext?: FocusContext;
  patchProposal?: PatchProposal;
  rawText: string;
}

export interface TaskEvent {
  taskId: string;
  type:
    | "task_started"
    | "stage_started"
    | "turn_recorded"
    | "stage_completed"
    | "verification_completed"
    | "needs_human_decision"
    | "task_completed"
    | "task_failed"
    | "task_stopped_budget"
    | "decision_applied";
  stage?: Stage;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface ProviderAdapter {
  readonly providerName: string;
  invoke(agent: AgentConfig, messages: AgentMessage[], context: AgentCallContext): Promise<AdapterResponse>;
}
