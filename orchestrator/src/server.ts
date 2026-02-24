import { runtimeConfig } from "./config.js";
import { createApp } from "./api/app.js";
import { TaskRunner } from "./engine/taskRunner.js";
import { AdapterFactory } from "./models/adapterFactory.js";
import { TaskEventBus } from "./services/taskEventBus.js";
import { RuntimeSettingsService } from "./services/runtimeSettings.js";
import { SqliteDatabase } from "./storage/database.js";
import { TaskStore } from "./storage/taskStore.js";

export interface RunningServer {
  close: () => void;
  app: ReturnType<typeof createApp>;
  taskStore: TaskStore;
  runner: TaskRunner;
}

export function buildServer() {
  const runtimeSettings = new RuntimeSettingsService(runtimeConfig.settingsPath);
  runtimeSettings.initialize();
  const sqlite = new SqliteDatabase(runtimeConfig.dbPath, runtimeConfig.schemaPath);
  sqlite.migrate();
  const store = new TaskStore(sqlite.db);
  const eventBus = new TaskEventBus();
  const adapters = new AdapterFactory(runtimeConfig.modelTimeoutMs);
  const runner = new TaskRunner(store, eventBus, adapters);
  const app = createApp(store, runner, eventBus, runtimeSettings);

  return {
    app,
    runner,
    taskStore: store,
    close: () => sqlite.close()
  };
}
