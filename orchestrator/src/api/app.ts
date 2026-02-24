import express from "express";
import cors from "cors";
import { z } from "zod";
import { agentConfigSchema, taskDecisionRequestSchema } from "@agent-hub/shared";
import { withDefaultTaskOptions } from "../config.js";
import { TaskRunner } from "../engine/taskRunner.js";
import { TaskStore } from "../storage/taskStore.js";
import { TaskEventBus } from "../services/taskEventBus.js";
import { RuntimeSettingsService } from "../services/runtimeSettings.js";

const optionalStringSetting = (maxLength: number) => z.string().max(maxLength).optional();

const optionalIntSetting = (min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" ? undefined : trimmed;
      }
      return value;
    },
    z.coerce.number().int().min(min).max(max).optional()
  );

const optionalNumberSetting = (min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" ? undefined : trimmed;
      }
      return value;
    },
    z.coerce.number().min(min).max(max).optional()
  );

const optionalBooleanSetting = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (trimmed === "") return undefined;
      if (trimmed === "true" || trimmed === "1") return true;
      if (trimmed === "false" || trimmed === "0") return false;
    }
    return value;
  },
  z.boolean().optional()
);

const optionalConsensusModeSetting = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    return value;
  },
  z.enum(["unanimous", "quorum", "judge"]).optional()
);

const runtimeSettingsUpdateSchema = z.object({
  openAIApiKey: optionalStringSetting(500),
  anthropicApiKey: optionalStringSetting(500),
  geminiApiKey: optionalStringSetting(500),
  agentsJson: optionalStringSetting(500_000),
  driverAgentId: optionalStringSetting(120),
  maxDebateRounds: optionalIntSetting(1, 5),
  maxRetriesPerStage: optionalIntSetting(0, 10),
  consensusMode: optionalConsensusModeSetting,
  quorumRatio: optionalNumberSetting(0.5, 1),
  criticalOnlyInFinalRound: optionalBooleanSetting,
  maxStageExecutions: optionalIntSetting(1, 20),
  maxModelCallsPerStage: optionalIntSetting(1, 200),
  maxModelCallsPerTask: optionalIntSetting(1, 2000),
  maxCostUsd: optionalNumberSetting(0.01, 1000)
});

export function createApp(
  taskStore: TaskStore,
  runner: TaskRunner,
  eventBus: TaskEventBus,
  runtimeSettings: RuntimeSettingsService
) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "agent-hub-orchestrator",
      timestamp: new Date().toISOString()
    });
  });

  app.get("/settings/runtime", (_req, res) => {
    res.json(runtimeSettings.getSummary());
  });

  app.post("/settings/runtime", (req, res) => {
    try {
      const payload = runtimeSettingsUpdateSchema.parse(req.body ?? {});
      if (payload.agentsJson) {
        const parsedAgents = JSON.parse(payload.agentsJson);
        z.array(agentConfigSchema).min(2).parse(parsedAgents);
      }
      const summary = runtimeSettings.update(payload);
      res.json(summary);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/tasks", (req, res) => {
    try {
      const request = withDefaultTaskOptions(req.body ?? {});
      const bundle = runner.startTask(request);
      res.status(201).json(bundle);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/tasks/:taskId", (req, res) => {
    try {
      const bundle = taskStore.getTaskBundle(req.params.taskId);
      res.json(bundle);
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/tasks/:taskId/decision", (req, res) => {
    try {
      const decision = taskDecisionRequestSchema.parse(req.body ?? {});
      const bundle = runner.applyDecision(req.params.taskId, decision);
      res.json(bundle);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/events/:taskId", (req, res) => {
    const taskId = req.params.taskId;
    const lastEventIdRaw = req.get("Last-Event-ID") ?? req.query.lastEventId;
    const lastEventId = Number(lastEventIdRaw ?? 0);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const existing = taskStore.getEvents(taskId, Number.isFinite(lastEventId) ? lastEventId : 0);
    for (const event of existing) {
      res.write(`event: ${event.type}\n`);
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    eventBus.subscribe(taskId, res);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      eventBus.unsubscribe(taskId, res);
      res.end();
    });
  });

  return app;
}
