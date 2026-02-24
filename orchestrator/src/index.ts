import dotenv from "dotenv";
import { runtimeConfig } from "./config.js";
import { buildServer } from "./server.js";

dotenv.config();

const { app, close } = buildServer();

const server = app.listen(runtimeConfig.port, () => {
  console.log(`[agent-hub] orchestrator listening on http://127.0.0.1:${runtimeConfig.port}`);
});

process.on("SIGINT", () => {
  server.close(() => {
    close();
    process.exit(0);
  });
});
