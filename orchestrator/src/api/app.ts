import express from "express";
import cors from "cors";
import { taskDecisionRequestSchema } from "@agent-hub/shared";
import { withDefaultTaskOptions } from "../config.js";
import { TaskRunner } from "../engine/taskRunner.js";
import { TaskStore } from "../storage/taskStore.js";
import { TaskEventBus } from "../services/taskEventBus.js";

export function createApp(taskStore: TaskStore, runner: TaskRunner, eventBus: TaskEventBus) {
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
