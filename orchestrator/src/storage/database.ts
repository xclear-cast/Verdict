import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export class SqliteDatabase {
  readonly db: Database.Database;

  constructor(private readonly dbPath: string, private readonly schemaPath: string) {
    const directory = path.dirname(dbPath);
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  migrate(): void {
    const schemaSql = fs.readFileSync(this.schemaPath, "utf8");
    this.db.exec(schemaSql);
  }

  close(): void {
    this.db.close();
  }
}
