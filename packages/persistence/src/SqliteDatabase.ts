import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationRunner } from "./MigrationRunner";
import { migrations } from "./migrations";

export class SqliteDatabase {
  readonly connection: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
    new MigrationRunner(this.connection, path, migrations).run();
  }
  close(): void { this.connection.close(); }
}
