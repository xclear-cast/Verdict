import type { AgentConfig, BudgetLimits, BudgetState, DebatePolicy, DebateTurn, Stage } from "@agent-hub/shared";

export interface ConsensusResult {
  approved: boolean;
  reason: string;
  approveCount: number;
  rejectCount: number;
  reviseCount: number;
}

export function selectDriverAgent(agents: AgentConfig[], preferredDriverAgentId?: string): AgentConfig {
  if (preferredDriverAgentId) {
    const preferred = agents.find((agent) => agent.id === preferredDriverAgentId);
    if (preferred) return preferred;
  }
  const explicitDriver = agents.find((agent) => agent.role === "driver");
  if (explicitDriver) return explicitDriver;
  return agents[0];
}

export function evaluateConsensus(agents: AgentConfig[], turnsForRound: DebateTurn[], policy: DebatePolicy): ConsensusResult {
  const latestByAgent = new Map<string, DebateTurn>();
  for (const turn of turnsForRound) {
    latestByAgent.set(turn.agentId, turn);
  }

  const verdicts = agents.map((agent) => latestByAgent.get(agent.id)?.verdict ?? "revise");
  const approveCount = verdicts.filter((verdict) => verdict === "approve").length;
  const rejectCount = verdicts.filter((verdict) => verdict === "reject").length;
  const reviseCount = verdicts.filter((verdict) => verdict === "revise").length;

  if (policy.consensusMode === "unanimous") {
    const approved = approveCount === agents.length;
    return {
      approved,
      reason: approved ? "all_agents_approved" : "waiting_for_unanimous_approval",
      approveCount,
      rejectCount,
      reviseCount
    };
  }

  if (policy.consensusMode === "judge") {
    const judges = agents.filter((agent) => agent.role === "judge");
    const judgeIds = judges.length ? judges.map((judge) => judge.id) : [agents[0].id];
    const judgeApprovals = judgeIds.every((judgeId) => latestByAgent.get(judgeId)?.verdict === "approve");
    return {
      approved: judgeApprovals,
      reason: judgeApprovals ? "judge_approved" : "judge_not_approved",
      approveCount,
      rejectCount,
      reviseCount
    };
  }

  const ratio = approveCount / agents.length;
  const approved = ratio >= policy.quorumRatio && rejectCount === 0;
  return {
    approved,
    reason: approved ? "quorum_approved" : "quorum_not_reached_or_rejected",
    approveCount,
    rejectCount,
    reviseCount
  };
}

export function createInitialBudget(taskId: string): BudgetState {
  return {
    taskId,
    modelCalls: 0,
    stageModelCalls: {
      discover: 0,
      plan: 0,
      patch: 0,
      verify: 0,
      finalize: 0
    },
    estimatedCostUsd: 0,
    limitExceeded: false
  };
}

export function applyBudgetCharge(
  budget: BudgetState,
  limits: BudgetLimits,
  stage: Stage,
  costPerCallUsd: number
): BudgetState {
  const next: BudgetState = {
    ...budget,
    modelCalls: budget.modelCalls + 1,
    stageModelCalls: {
      ...budget.stageModelCalls,
      [stage]: (budget.stageModelCalls[stage] ?? 0) + 1
    },
    estimatedCostUsd: Number((budget.estimatedCostUsd + costPerCallUsd).toFixed(6)),
    limitExceeded: false
  };

  next.limitExceeded =
    next.modelCalls > limits.maxModelCallsPerTask ||
    next.stageModelCalls[stage] > limits.maxModelCallsPerStage ||
    next.estimatedCostUsd > limits.maxCostUsd;
  return next;
}

export function shouldUseCriticalOnlyRound(round: number, policy: DebatePolicy): boolean {
  if (!policy.criticalOnlyInFinalRound) return false;
  return round >= policy.maxDebateRounds;
}
