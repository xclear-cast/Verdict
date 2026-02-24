import type Database from "better-sqlite3";
import type {
  BudgetState,
  DebateTurn,
  PatchProposal,
  Stage,
  TaskDecisionRequest,
  TaskEvent,
  TaskRecord,
  TaskRequest,
  TaskSummary,
  VerificationResult
} from "@agent-hub/shared";
import { STAGES } from "@agent-hub/shared";

interface TaskRow {
  id: string;
  workspace_path: string;
  user_goal: string;
  status: TaskRecord["status"];
  current_stage: Stage;
  current_attempt: number;
  request_json: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

interface BudgetRow {
  task_id: string;
  model_calls: number;
  stage_calls_json: string;
  estimated_cost_usd: number;
  limit_exceeded: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyStageCalls(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
}

function parseTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    userGoal: row.user_goal,
    status: row.status,
    currentStage: row.current_stage,
    currentAttempt: row.current_attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? undefined
  };
}

export interface TaskBundle {
  task: TaskRecord;
  request: TaskRequest;
  budget: BudgetState;
  turns: DebateTurn[];
  events: TaskEvent[];
  latestPatch?: PatchProposal;
  latestVerification?: VerificationResult;
}

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  createTask(taskId: string, request: TaskRequest): TaskRecord {
    const timestamp = nowIso();
    const initialStage = STAGES[0];
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_path, user_goal, status, current_stage, current_attempt, request_json, created_at, updated_at)
         VALUES (@id, @workspacePath, @userGoal, @status, @currentStage, @currentAttempt, @requestJson, @createdAt, @updatedAt)`
      )
      .run({
        id: taskId,
        workspacePath: request.workspacePath,
        userGoal: request.userGoal,
        status: "queued",
        currentStage: initialStage,
        currentAttempt: 0,
        requestJson: JSON.stringify(request),
        createdAt: timestamp,
        updatedAt: timestamp
      });

    this.db
      .prepare(
        `INSERT INTO budgets (task_id, model_calls, stage_calls_json, estimated_cost_usd, limit_exceeded, updated_at)
         VALUES (@taskId, 0, @stageCallsJson, 0, 0, @updatedAt)`
      )
      .run({
        taskId,
        stageCallsJson: JSON.stringify(createEmptyStageCalls()),
        updatedAt: timestamp
      });

    return this.getTask(taskId);
  }

  getTask(taskId: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) {
      throw new Error(`TASK_NOT_FOUND:${taskId}`);
    }
    return parseTaskRow(row);
  }

  getRequest(taskId: string): TaskRequest {
    const row = this.db
      .prepare("SELECT request_json FROM tasks WHERE id = ?")
      .get(taskId) as { request_json: string } | undefined;
    if (!row) {
      throw new Error(`TASK_NOT_FOUND:${taskId}`);
    }
    return JSON.parse(row.request_json) as TaskRequest;
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, "status" | "currentStage" | "currentAttempt" | "lastError">>): TaskRecord {
    const current = this.getTask(taskId);
    const merged: TaskRecord = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    this.db
      .prepare(
        `UPDATE tasks
           SET status = @status,
               current_stage = @currentStage,
               current_attempt = @currentAttempt,
               last_error = @lastError,
               updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: taskId,
        status: merged.status,
        currentStage: merged.currentStage,
        currentAttempt: merged.currentAttempt,
        lastError: merged.lastError ?? null,
        updatedAt: merged.updatedAt
      });
    return this.getTask(taskId);
  }

  getBudget(taskId: string): BudgetState {
    const row = this.db.prepare("SELECT * FROM budgets WHERE task_id = ?").get(taskId) as BudgetRow | undefined;
    if (!row) {
      throw new Error(`BUDGET_NOT_FOUND:${taskId}`);
    }
    return {
      taskId: row.task_id,
      modelCalls: row.model_calls,
      stageModelCalls: JSON.parse(row.stage_calls_json) as Record<Stage, number>,
      estimatedCostUsd: row.estimated_cost_usd,
      limitExceeded: Boolean(row.limit_exceeded)
    };
  }

  upsertBudget(state: BudgetState): BudgetState {
    this.db
      .prepare(
        `INSERT INTO budgets (task_id, model_calls, stage_calls_json, estimated_cost_usd, limit_exceeded, updated_at)
         VALUES (@taskId, @modelCalls, @stageCallsJson, @estimatedCostUsd, @limitExceeded, @updatedAt)
         ON CONFLICT(task_id) DO UPDATE SET
           model_calls = excluded.model_calls,
           stage_calls_json = excluded.stage_calls_json,
           estimated_cost_usd = excluded.estimated_cost_usd,
           limit_exceeded = excluded.limit_exceeded,
           updated_at = excluded.updated_at`
      )
      .run({
        taskId: state.taskId,
        modelCalls: state.modelCalls,
        stageCallsJson: JSON.stringify(state.stageModelCalls),
        estimatedCostUsd: state.estimatedCostUsd,
        limitExceeded: state.limitExceeded ? 1 : 0,
        updatedAt: nowIso()
      });
    return this.getBudget(state.taskId);
  }

  saveTurn(turn: DebateTurn): void {
    this.db
      .prepare(
        `INSERT INTO debate_turns
         (task_id, stage, round, attempt, agent_id, provider, message, verdict, risks_json, focus_context_json, patch_json, timestamp)
         VALUES (@taskId, @stage, @round, @attempt, @agentId, @provider, @message, @verdict, @risksJson, @focusContextJson, @patchJson, @timestamp)`
      )
      .run({
        taskId: turn.taskId,
        stage: turn.stage,
        round: turn.round,
        attempt: turn.attempt,
        agentId: turn.agentId,
        provider: turn.provider,
        message: turn.message,
        verdict: turn.verdict,
        risksJson: JSON.stringify(turn.risks),
        focusContextJson: turn.focusContext ? JSON.stringify(turn.focusContext) : null,
        patchJson: turn.patchProposal ? JSON.stringify(turn.patchProposal) : null,
        timestamp: turn.timestamp
      });
  }

  listTurns(taskId: string): DebateTurn[] {
    const rows = this.db
      .prepare("SELECT * FROM debate_turns WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as Array<{
      task_id: string;
      stage: Stage;
      round: number;
      attempt: number;
      agent_id: string;
      provider: string;
      message: string;
      verdict: "approve" | "revise" | "reject";
      risks_json: string;
      focus_context_json: string | null;
      patch_json: string | null;
      timestamp: string;
    }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      stage: row.stage,
      round: row.round,
      attempt: row.attempt,
      agentId: row.agent_id,
      provider: row.provider,
      message: row.message,
      verdict: row.verdict,
      risks: JSON.parse(row.risks_json) as string[],
      focusContext: row.focus_context_json ? (JSON.parse(row.focus_context_json) as DebateTurn["focusContext"]) : undefined,
      patchProposal: row.patch_json ? (JSON.parse(row.patch_json) as PatchProposal) : undefined,
      timestamp: row.timestamp
    }));
  }

  savePatch(taskId: string, patch: PatchProposal, applied = false, blockedReason?: string): void {
    this.db
      .prepare(
        `INSERT INTO patches
         (task_id, stage, summary, unified_diff, touched_files_json, confidence, edit_ops_json, applied, blocked_reason, created_at)
         VALUES (@taskId, @stage, @summary, @unifiedDiff, @touchedFilesJson, @confidence, @editOpsJson, @applied, @blockedReason, @createdAt)`
      )
      .run({
        taskId,
        stage: patch.stage,
        summary: patch.summary,
        unifiedDiff: patch.unifiedDiff ?? null,
        touchedFilesJson: JSON.stringify(patch.touchedFiles),
        confidence: patch.confidence,
        editOpsJson: JSON.stringify(patch.editOperations),
        applied: applied ? 1 : 0,
        blockedReason: blockedReason ?? null,
        createdAt: nowIso()
      });
  }

  markLatestPatchApplied(taskId: string, applied: boolean, blockedReason?: string): void {
    const row = this.db
      .prepare("SELECT id FROM patches WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as { id: number } | undefined;
    if (!row) return;
    this.db
      .prepare("UPDATE patches SET applied = ?, blocked_reason = ? WHERE id = ?")
      .run(applied ? 1 : 0, blockedReason ?? null, row.id);
  }

  getLatestPatch(taskId: string): PatchProposal | undefined {
    const row = this.db
      .prepare("SELECT * FROM patches WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as
      | {
          task_id: string;
          stage: "patch";
          summary: string;
          unified_diff: string | null;
          touched_files_json: string;
          confidence: number;
          edit_ops_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      stage: row.stage,
      summary: row.summary,
      unifiedDiff: row.unified_diff ?? undefined,
      touchedFiles: JSON.parse(row.touched_files_json) as string[],
      confidence: row.confidence,
      editOperations: JSON.parse(row.edit_ops_json) as PatchProposal["editOperations"]
    };
  }

  saveVerification(result: VerificationResult): void {
    this.db
      .prepare(
        `INSERT INTO verifications
         (task_id, commands_json, outputs_json, passed, failures_json, had_test_command, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.taskId,
        JSON.stringify(result.commands),
        JSON.stringify(result.outputs),
        result.passed ? 1 : 0,
        JSON.stringify(result.failures),
        result.hadTestCommand ? 1 : 0,
        result.timestamp
      );
  }

  getLatestVerification(taskId: string): VerificationResult | undefined {
    const row = this.db
      .prepare("SELECT * FROM verifications WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as
      | {
          task_id: string;
          commands_json: string;
          outputs_json: string;
          passed: number;
          failures_json: string;
          had_test_command: number;
          timestamp: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      stage: "verify",
      commands: JSON.parse(row.commands_json) as string[],
      outputs: JSON.parse(row.outputs_json) as VerificationResult["outputs"],
      passed: Boolean(row.passed),
      failures: JSON.parse(row.failures_json) as string[],
      hadTestCommand: Boolean(row.had_test_command),
      timestamp: row.timestamp
    };
  }

  saveDecision(taskId: string, decision: TaskDecisionRequest): void {
    this.db
      .prepare("INSERT INTO decisions (task_id, action, note, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, decision.action, decision.note ?? null, nowIso());
  }

  saveEvent(event: TaskEvent): number {
    const result = this.db
      .prepare("INSERT INTO events (task_id, type, stage, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.taskId, event.type, event.stage ?? null, JSON.stringify(event.data ?? {}), event.createdAt);
    return Number(result.lastInsertRowid);
  }

  getEvents(taskId: string, sinceId = 0): Array<TaskEvent & { id: number }> {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC")
      .all(taskId, sinceId) as Array<{
      id: number;
      task_id: string;
      type: TaskEvent["type"];
      stage: Stage | null;
      data_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      stage: row.stage ?? undefined,
      data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : {},
      createdAt: row.created_at
    }));
  }

  getTaskSummary(taskId: string): TaskSummary {
    const task = this.getTask(taskId);
    return {
      ...task,
      budget: this.getBudget(taskId)
    };
  }

  getTaskBundle(taskId: string): TaskBundle {
    return {
      task: this.getTask(taskId),
      request: this.getRequest(taskId),
      budget: this.getBudget(taskId),
      turns: this.listTurns(taskId),
      events: this.getEvents(taskId),
      latestPatch: this.getLatestPatch(taskId),
      latestVerification: this.getLatestVerification(taskId)
    };
  }
}
