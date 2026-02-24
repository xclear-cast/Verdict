import { v4 as uuidv4 } from "uuid";
import {
  STAGES,
  taskDecisionRequestSchema,
  taskRequestSchema,
  type AgentConfig,
  type DebateTurn,
  type PatchProposal,
  type ProtectionPolicy,
  type Stage,
  type TaskDecisionRequest,
  type TaskEvent,
  type TaskRequest
} from "@agent-hub/shared";
import { AdapterFactory } from "../models/adapterFactory.js";
import { buildAgentMessages } from "./prompts.js";
import { applyBudgetCharge, createInitialBudget, evaluateConsensus, selectDriverAgent, shouldUseCriticalOnlyRound } from "./policy.js";
import { TaskStore, type TaskBundle } from "../storage/taskStore.js";
import { TaskEventBus } from "../services/taskEventBus.js";
import { applyEditOperations } from "../services/patchApplier.js";
import { evaluatePatchSafety } from "../services/patchSafety.js";
import { runVerification } from "../services/verificationRunner.js";

type StageAccessMode = "read_only" | "workspace" | "full_access";

type StageRunOutcome =
  | { status: "ok"; accessMode: StageAccessMode; autoFullAccessByUnanimous: boolean }
  | { status: "needs_human_decision"; reason: string }
  | { status: "stopped_budget"; reason: string }
  | { status: "failed"; reason: string };

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizePatchProposal(taskId: string, proposal: PatchProposal): PatchProposal {
  const touched = new Set<string>(proposal.touchedFiles);
  for (const operation of proposal.editOperations) {
    touched.add(operation.path);
  }
  return {
    ...proposal,
    taskId,
    touchedFiles: Array.from(touched)
  };
}

function isUnanimousApprove(agents: AgentConfig[], roundTurns: DebateTurn[]): boolean {
  const byAgent = new Map(roundTurns.map((turn) => [turn.agentId, turn]));
  if (byAgent.size < agents.length) return false;
  for (const agent of agents) {
    const turn = byAgent.get(agent.id);
    if (!turn || turn.verdict !== "approve") return false;
  }
  return true;
}

function isReadOnlyPolicy(policy: ProtectionPolicy): boolean {
  return (
    !policy.allowPathEscape &&
    !policy.allowTestChangesWithApproval &&
    policy.protectedPathPatterns.includes("**/*") &&
    policy.protectedTestPathPatterns.includes("**/*")
  );
}

function isFullAccessPolicy(policy: ProtectionPolicy): boolean {
  return (
    Boolean(policy.allowPathEscape) &&
    Boolean(policy.allowTestChangesWithApproval) &&
    policy.protectedPathPatterns.length === 0 &&
    policy.protectedTestPathPatterns.length === 0
  );
}

function asFullAccessPolicy(): ProtectionPolicy {
  return {
    protectedPathPatterns: [],
    protectedTestPathPatterns: [],
    allowTestChangesWithApproval: true,
    allowPathEscape: true
  };
}

function resolveStageProtectionPolicy(
  basePolicy: ProtectionPolicy,
  unanimousApproved: boolean,
  enableUnanimousAutoFullAccess: boolean
): { policy: ProtectionPolicy; accessMode: StageAccessMode; autoFullAccessByUnanimous: boolean } {
  if (isReadOnlyPolicy(basePolicy)) {
    return { policy: basePolicy, accessMode: "read_only", autoFullAccessByUnanimous: false };
  }
  if (isFullAccessPolicy(basePolicy)) {
    return { policy: basePolicy, accessMode: "full_access", autoFullAccessByUnanimous: false };
  }
  if (enableUnanimousAutoFullAccess && unanimousApproved) {
    return { policy: asFullAccessPolicy(), accessMode: "full_access", autoFullAccessByUnanimous: true };
  }
  return { policy: basePolicy, accessMode: "workspace", autoFullAccessByUnanimous: false };
}

function getStageConstraints(stage: Stage): string[] {
  const sharedConstraints = [
    "Never modify protected secrets or CI/deploy files.",
    "Use precise technical reasoning and keep output JSON-only.",
    "When proposing edits, prefer minimal changes with clear file paths."
  ];
  if (stage === "discover") {
    return [...sharedConstraints, "Use lazy discovery. Prefer file listing before reading full files."];
  }
  if (stage === "verify") {
    return [
      ...sharedConstraints,
      "Use only critical bug findings.",
      "Use stderr/stdout evidence when proposing fixes.",
      "Do not weaken tests to pass."
    ];
  }
  if (stage === "patch") {
    return [
      ...sharedConstraints,
      "Prefer edit operations (replace/rewrite/create/delete/append) over raw diff-only patching."
    ];
  }
  return sharedConstraints;
}

export class TaskRunner {
  private readonly runningTasks = new Set<string>();

  constructor(
    private readonly store: TaskStore,
    private readonly eventBus: TaskEventBus,
    private readonly adapterFactory: AdapterFactory
  ) {}

  startTask(input: TaskRequest): TaskBundle {
    const request = taskRequestSchema.parse(input);
    const taskId = uuidv4();
    this.store.createTask(taskId, request);
    this.store.upsertBudget(createInitialBudget(taskId));
    this.store.updateTask(taskId, { status: "running", currentStage: STAGES[0], currentAttempt: 0, lastError: undefined });
    this.publishEvent({
      taskId,
      type: "task_started",
      stage: STAGES[0],
      data: { agents: request.agents.map((agent) => agent.id) },
      createdAt: nowIso()
    });
    void this.runTask(taskId, STAGES[0]);
    return this.store.getTaskBundle(taskId);
  }

  applyDecision(taskId: string, rawDecision: TaskDecisionRequest): TaskBundle {
    const decision = taskDecisionRequestSchema.parse(rawDecision);
    this.store.saveDecision(taskId, decision);
    this.publishEvent({
      taskId,
      type: "decision_applied",
      data: { action: decision.action, note: decision.note ?? null },
      createdAt: nowIso()
    });

    if (decision.action === "stop_task") {
      this.store.updateTask(taskId, { status: "failed", lastError: decision.note ?? "Stopped by user." });
      this.publishEvent({
        taskId,
        type: "task_failed",
        data: { reason: decision.note ?? "Stopped by user." },
        createdAt: nowIso()
      });
      return this.store.getTaskBundle(taskId);
    }

    if (decision.action === "reject_patch") {
      this.store.updateTask(taskId, { status: "failed", lastError: decision.note ?? "Patch rejected by user." });
      this.publishEvent({
        taskId,
        type: "task_failed",
        data: { reason: decision.note ?? "Patch rejected by user." },
        createdAt: nowIso()
      });
      return this.store.getTaskBundle(taskId);
    }

    const task = this.store.getTask(taskId);
    const startStage = task.currentStage;
    this.store.updateTask(taskId, { status: "running", lastError: undefined });
    void this.runTask(taskId, startStage);
    return this.store.getTaskBundle(taskId);
  }

  getTaskBundle(taskId: string): TaskBundle {
    return this.store.getTaskBundle(taskId);
  }

  private publishEvent(event: TaskEvent): void {
    const id = this.store.saveEvent(event);
    this.eventBus.publish({ ...event, id });
  }

  private async runTask(taskId: string, startStage: Stage): Promise<void> {
    if (this.runningTasks.has(taskId)) {
      return;
    }
    this.runningTasks.add(taskId);
    try {
      const request = this.store.getRequest(taskId);
      const startIndex = Math.max(STAGES.indexOf(startStage), 0);
      for (let index = startIndex; index < STAGES.length; index += 1) {
        const stage = STAGES[index];
        this.store.updateTask(taskId, {
          status: "running",
          currentStage: stage,
          currentAttempt: 0,
          lastError: undefined
        });
        this.publishEvent({
          taskId,
          type: "stage_started",
          stage,
          data: { stageIndex: index },
          createdAt: nowIso()
        });

        const outcome = await this.runStage(taskId, stage, request);
        if (outcome.status === "ok") {
          this.publishEvent({
            taskId,
            type: "stage_completed",
            stage,
            data: {
              approved: true,
              accessMode: outcome.accessMode,
              autoFullAccessByUnanimous: outcome.autoFullAccessByUnanimous
            },
            createdAt: nowIso()
          });
          continue;
        }

        if (outcome.status === "stopped_budget") {
          this.store.updateTask(taskId, { status: "stopped_budget", lastError: outcome.reason });
          this.publishEvent({
            taskId,
            type: "task_stopped_budget",
            stage,
            data: { reason: outcome.reason },
            createdAt: nowIso()
          });
          return;
        }

        if (outcome.status === "needs_human_decision") {
          this.store.updateTask(taskId, { status: "needs_human_decision", lastError: outcome.reason });
          this.publishEvent({
            taskId,
            type: "needs_human_decision",
            stage,
            data: { reason: outcome.reason },
            createdAt: nowIso()
          });
          return;
        }

        this.store.updateTask(taskId, { status: "failed", lastError: outcome.reason });
        this.publishEvent({
          taskId,
          type: "task_failed",
          stage,
          data: { reason: outcome.reason },
          createdAt: nowIso()
        });
        return;
      }

      this.store.updateTask(taskId, { status: "completed", currentStage: "finalize", lastError: undefined });
      this.publishEvent({
        taskId,
        type: "task_completed",
        stage: "finalize",
        createdAt: nowIso()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTask(taskId, { status: "failed", lastError: message });
      this.publishEvent({
        taskId,
        type: "task_failed",
        data: { reason: message },
        createdAt: nowIso()
      });
    } finally {
      this.runningTasks.delete(taskId);
    }
  }

  private async runStage(taskId: string, stage: Stage, request: TaskRequest): Promise<StageRunOutcome> {
    const driver = selectDriverAgent(request.agents, request.driverAgentId);

    for (let attempt = 0; attempt <= request.debatePolicy.maxRetriesPerStage; attempt += 1) {
      this.store.updateTask(taskId, { currentAttempt: attempt });
      const turnsForAttempt: DebateTurn[] = [];
      let consensusApproved = false;
      let unanimousApproved = false;

      for (let round = 1; round <= request.debatePolicy.maxDebateRounds; round += 1) {
        for (const agent of request.agents) {
          const charged = this.chargeBudget(taskId, request, stage, agent);
          if (charged.limitExceeded) {
            return { status: "stopped_budget", reason: "Budget limit exceeded." };
          }

          const context = {
            taskId,
            stage,
            attempt,
            round,
            workspacePath: request.workspacePath,
            userGoal: request.userGoal,
            criticalOnly: shouldUseCriticalOnlyRound(round, request.debatePolicy),
            constraints: getStageConstraints(stage),
            recentTurns: this.store.listTurns(taskId).slice(-10),
            latestPatchProposal: this.store.getLatestPatch(taskId),
            latestVerification: this.store.getLatestVerification(taskId)
          } as const;

          const adapter = this.adapterFactory.resolve(agent.provider);
          const messages = buildAgentMessages(agent, context);

          let lastError: Error | undefined;
          let response:
            | {
                message: string;
                verdict: "approve" | "revise" | "reject";
                risks: string[];
                focusContext?: { filePath: string; startLine?: number; endLine?: number };
                patchProposal?: PatchProposal;
              }
            | undefined;

          for (let retry = 0; retry < 2; retry += 1) {
            try {
              response = await adapter.invoke(agent, messages, context);
              break;
            } catch (error) {
              lastError = error as Error;
            }
          }
          if (!response) {
            return {
              status: "failed",
              reason: `MODEL_CALL_FAILED:${agent.id}:${lastError?.message ?? "Unknown"}`
            };
          }

          const turn: DebateTurn = {
            taskId,
            stage,
            round,
            attempt,
            agentId: agent.id,
            provider: agent.provider,
            message: response.message,
            verdict: response.verdict,
            risks: response.risks,
            focusContext: response.focusContext,
            patchProposal: response.patchProposal ? sanitizePatchProposal(taskId, response.patchProposal) : undefined,
            timestamp: nowIso()
          };
          this.store.saveTurn(turn);
          turnsForAttempt.push(turn);
          this.publishEvent({
            taskId,
            type: "turn_recorded",
            stage,
            data: {
              round,
              attempt,
              agentId: agent.id,
              verdict: turn.verdict
            },
            createdAt: nowIso()
          });
        }

        const roundTurns = turnsForAttempt.filter((turn) => turn.round === round);
        const consensus = evaluateConsensus(request.agents, roundTurns, request.debatePolicy);
        if (consensus.approved) {
          consensusApproved = true;
          unanimousApproved = isUnanimousApprove(request.agents, roundTurns);
          break;
        }
      }

      if (!consensusApproved) {
        if (attempt < request.debatePolicy.maxRetriesPerStage) {
          continue;
        }
        return { status: "needs_human_decision", reason: `CONSENSUS_FAILED:${stage}` };
      }

      const stagePolicy = resolveStageProtectionPolicy(
        request.protectionPolicy,
        unanimousApproved,
        request.debatePolicy.enableUnanimousAutoFullAccess
      );

      if (stage === "patch") {
        const selectedPatch = this.selectPatchProposal(turnsForAttempt, driver.id);
        if (!selectedPatch) {
          if (attempt < request.debatePolicy.maxRetriesPerStage) continue;
          return { status: "needs_human_decision", reason: "PATCH_PROPOSAL_MISSING" };
        }
        const patch = sanitizePatchProposal(taskId, selectedPatch);
        this.store.savePatch(taskId, patch, false);
        const safety = evaluatePatchSafety(request.workspacePath, patch, stagePolicy.policy);
        if (safety.blocked) {
          this.store.markLatestPatchApplied(taskId, false, safety.reason);
          if (attempt < request.debatePolicy.maxRetriesPerStage) continue;
          return { status: "needs_human_decision", reason: safety.reason ?? "PATCH_BLOCKED" };
        }

        const applyResult = applyEditOperations(request.workspacePath, patch.editOperations);
        if (!applyResult.success) {
          this.store.markLatestPatchApplied(taskId, false, applyResult.errors.join("; "));
          if (attempt < request.debatePolicy.maxRetriesPerStage) continue;
          return { status: "needs_human_decision", reason: `PATCH_APPLY_FAILED:${applyResult.errors.join(";")}` };
        }
        this.store.markLatestPatchApplied(taskId, true);
      }

      if (stage === "verify") {
        const verification = await runVerification(taskId, request.workspacePath, request.verificationPolicy);
        this.store.saveVerification(verification);
        this.publishEvent({
          taskId,
          type: "verification_completed",
          stage,
          data: { passed: verification.passed, failures: verification.failures },
          createdAt: nowIso()
        });

        if (!verification.passed) {
          const stageFixPatch = this.selectPatchProposal(turnsForAttempt, driver.id);
          if (stageFixPatch) {
            const patch = sanitizePatchProposal(taskId, stageFixPatch);
            this.store.savePatch(taskId, patch, false);
            const safety = evaluatePatchSafety(request.workspacePath, patch, stagePolicy.policy);
            if (!safety.blocked) {
              const applyResult = applyEditOperations(request.workspacePath, patch.editOperations);
              this.store.markLatestPatchApplied(taskId, applyResult.success, applyResult.errors.join("; "));
            } else {
              this.store.markLatestPatchApplied(taskId, false, safety.reason);
            }
          }

          if (attempt < request.debatePolicy.maxRetriesPerStage) {
            continue;
          }
          return { status: "needs_human_decision", reason: `VERIFY_FAILED:${verification.failures.join(",")}` };
        }
      }

      if (stage === "finalize") {
        const latestVerification = this.store.getLatestVerification(taskId);
        if (!latestVerification || !latestVerification.passed) {
          return { status: "needs_human_decision", reason: "FINALIZE_WITHOUT_PASSING_VERIFICATION" };
        }
      }

      return {
        status: "ok",
        accessMode: stagePolicy.accessMode,
        autoFullAccessByUnanimous: stagePolicy.autoFullAccessByUnanimous
      };
    }

    return { status: "failed", reason: `UNEXPECTED_STAGE_EXIT:${stage}` };
  }

  private selectPatchProposal(turns: DebateTurn[], driverAgentId: string): PatchProposal | undefined {
    const driverPatch = [...turns]
      .reverse()
      .find((turn) => turn.agentId === driverAgentId && turn.patchProposal)?.patchProposal;
    if (driverPatch) return driverPatch;
    return [...turns].reverse().find((turn) => turn.patchProposal)?.patchProposal;
  }

  private chargeBudget(taskId: string, request: TaskRequest, stage: Stage, agent: AgentConfig) {
    const current = this.store.getBudget(taskId);
    const charged = applyBudgetCharge(current, request.budgetLimits, stage, agent.costPerCallUsd ?? 0.01);
    this.store.upsertBudget(charged);
    return charged;
  }
}
