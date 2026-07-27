import { copyFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations";

export class MigrationRunner {
  constructor(private readonly database: DatabaseSync, private readonly databasePath: string,
    private readonly migrations: readonly Migration[]) {}

  run(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const rows = this.database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    const applied = new Set(rows.map((row) => row.version));
    for (const migration of [...this.migrations].sort((left, right) => left.version - right.version)) {
      if (applied.has(migration.version)) continue;
      if (migration.destructive === true && this.databasePath !== ":memory:" && existsSync(this.databasePath)) {
        copyFileSync(this.databasePath, `${this.databasePath}.backup-before-v${String(migration.version)}`);
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sql);
        this.database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
  }
}
