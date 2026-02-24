import type { Response } from "express";
import type { TaskEvent } from "@agent-hub/shared";

export class TaskEventBus {
  private subscribers = new Map<string, Set<Response>>();

  subscribe(taskId: string, res: Response): void {
    const set = this.subscribers.get(taskId) ?? new Set<Response>();
    set.add(res);
    this.subscribers.set(taskId, set);
  }

  unsubscribe(taskId: string, res: Response): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      this.subscribers.delete(taskId);
    }
  }

  publish(event: TaskEvent & { id?: number }): void {
    const set = this.subscribers.get(event.taskId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(event);
    for (const res of set) {
      res.write(`event: ${event.type}\n`);
      if (typeof event.id === "number") {
        res.write(`id: ${event.id}\n`);
      }
      res.write(`data: ${payload}\n\n`);
    }
  }
}
