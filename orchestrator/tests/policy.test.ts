import { describe, expect, it } from "vitest";
import type { AgentConfig, DebateTurn } from "@agent-hub/shared";
import { applyBudgetCharge, createInitialBudget, evaluateConsensus, selectDriverAgent } from "../src/engine/policy.js";

const agents: AgentConfig[] = [
  { id: "a1", provider: "mock", role: "driver", model: "m1" },
  { id: "a2", provider: "mock", role: "reviewer", model: "m2" },
  { id: "a3", provider: "mock", role: "judge", model: "m3" }
];

function buildTurn(agentId: string, verdict: DebateTurn["verdict"]): DebateTurn {
  return {
    taskId: "task",
    stage: "plan",
    round: 1,
    attempt: 0,
    agentId,
    provider: "mock",
    message: "ok",
    verdict,
    risks: [],
    timestamp: new Date().toISOString()
  };
}

describe("policy.evaluateConsensus", () => {
  it("approves unanimous mode only when all approve", () => {
    const approved = evaluateConsensus(
      agents.slice(0, 2),
      [buildTurn("a1", "approve"), buildTurn("a2", "approve")],
      {
        maxDebateRounds: 2,
        maxRetriesPerStage: 2,
        consensusMode: "unanimous",
        quorumRatio: 1,
        criticalOnlyInFinalRound: true,
        enableUnanimousAutoFullAccess: true
      }
    );
    expect(approved.approved).toBe(true);

    const rejected = evaluateConsensus(
      agents.slice(0, 2),
      [buildTurn("a1", "approve"), buildTurn("a2", "revise")],
      {
        maxDebateRounds: 2,
        maxRetriesPerStage: 2,
        consensusMode: "unanimous",
        quorumRatio: 1,
        criticalOnlyInFinalRound: true,
        enableUnanimousAutoFullAccess: true
      }
    );
    expect(rejected.approved).toBe(false);
  });

  it("supports judge mode", () => {
    const approved = evaluateConsensus(
      agents,
      [buildTurn("a1", "reject"), buildTurn("a2", "approve"), buildTurn("a3", "approve")],
      {
        maxDebateRounds: 2,
        maxRetriesPerStage: 2,
        consensusMode: "judge",
        quorumRatio: 0.67,
        criticalOnlyInFinalRound: true,
        enableUnanimousAutoFullAccess: true
      }
    );
    expect(approved.approved).toBe(true);
  });
});

describe("policy.selectDriverAgent", () => {
  it("prefers configured driverAgentId when matched", () => {
    const selected = selectDriverAgent(agents, "a2");
    expect(selected.id).toBe("a2");
  });

  it("falls back to role=driver when configured id is missing", () => {
    const selected = selectDriverAgent(agents, "missing");
    expect(selected.id).toBe("a1");
  });
});

describe("policy.applyBudgetCharge", () => {
  it("marks limit exceeded when total model calls are above threshold", () => {
    const initial = createInitialBudget("task-1");
    const charged = applyBudgetCharge(
      initial,
      {
        maxStageExecutions: 5,
        maxModelCallsPerStage: 2,
        maxModelCallsPerTask: 1,
        maxCostUsd: 1
      },
      "discover",
      0.5
    );
    expect(charged.limitExceeded).toBe(false);

    const chargedAgain = applyBudgetCharge(
      charged,
      {
        maxStageExecutions: 5,
        maxModelCallsPerStage: 2,
        maxModelCallsPerTask: 1,
        maxCostUsd: 1
      },
      "discover",
      0.5
    );
    expect(chargedAgain.limitExceeded).toBe(true);
  });
});
