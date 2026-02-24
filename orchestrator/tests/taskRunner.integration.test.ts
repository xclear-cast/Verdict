import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@agent-hub/shared";
import { SqliteDatabase } from "../src/storage/database.js";
import { TaskStore } from "../src/storage/taskStore.js";
import { TaskEventBus } from "../src/services/taskEventBus.js";
import { AdapterFactory } from "../src/models/adapterFactory.js";
import { TaskRunner } from "../src/engine/taskRunner.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(taskStore: TaskStore, taskId: string, statuses: TaskStatus[]): Promise<TaskStatus> {
  for (let i = 0; i < 80; i += 1) {
    const status = taskStore.getTask(taskId).status;
    if (statuses.includes(status)) {
      return status;
    }
    await delay(50);
  }
  throw new Error("Timeout waiting for task status");
}

describe("TaskRunner integration", () => {
  it("runs a full mock task and records turns", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-"));
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "tmp", scripts: { test: "echo ok" } }));
    const schemaPath = path.resolve(process.cwd(), "../data/schema.sql");
    const sqlite = new SqliteDatabase(":memory:", schemaPath);
    sqlite.migrate();
    const store = new TaskStore(sqlite.db);
    const runner = new TaskRunner(store, new TaskEventBus(), new AdapterFactory(1000));

    const bundle = runner.startTask({
      workspacePath: tempRoot,
      userGoal: "Create debate demo",
      agents: [
        { id: "driver", provider: "mock", role: "driver", model: "mock-driver", costPerCallUsd: 0.01 },
        { id: "reviewer", provider: "mock", role: "reviewer", model: "mock-reviewer", costPerCallUsd: 0.01 }
      ],
      debatePolicy: {
        maxDebateRounds: 2,
        maxRetriesPerStage: 1,
        consensusMode: "unanimous",
        quorumRatio: 1,
        criticalOnlyInFinalRound: true
      },
      budgetLimits: {
        maxStageExecutions: 5,
        maxModelCallsPerStage: 20,
        maxModelCallsPerTask: 80,
        maxCostUsd: 5
      },
      protectionPolicy: {
        protectedPathPatterns: [".env*", "**/.env*"],
        protectedTestPathPatterns: ["**/*.test.*", "**/__tests__/**"],
        allowTestChangesWithApproval: false
      },
      verificationPolicy: {
        commandAllowlist: ["npm test"],
        requireAtLeastOneTestCommand: false,
        autoApplyOnTestPass: true
      }
    });

    const terminalStatus = await waitForStatus(store, bundle.task.id, ["completed", "needs_human_decision", "failed"]);
    expect(terminalStatus).toBe("completed");

    const turns = store.listTurns(bundle.task.id);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some((turn) => turn.agentId === "driver")).toBe(true);
    expect(turns.some((turn) => turn.agentId === "reviewer")).toBe(true);
    sqlite.close();
  });
});
