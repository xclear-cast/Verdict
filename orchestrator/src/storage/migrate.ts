import dotenv from "dotenv";
import { runtimeConfig } from "../config.js";
import { SqliteDatabase } from "./database.js";

dotenv.config();

const sqlite = new SqliteDatabase(runtimeConfig.dbPath, runtimeConfig.schemaPath);
sqlite.migrate();
sqlite.close();

console.log(`[agent-hub] migration completed: ${runtimeConfig.dbPath}`);
