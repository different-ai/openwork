import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { MigrationResult } from "../types.js";
import { phase2RegistryRuntimeMigration } from "./0001-registry-runtime.js";
import { phase2ManagedStateMigration } from "./0002-managed-state.js";
import { phase7FilesConfigMigration } from "./0003-files-config.js";

const migrations = [phase2RegistryRuntimeMigration, phase2ManagedStateMigration, phase7FilesConfigMigration].map((migration) => ({
  ...migration,
  checksum: createHash("sha256").update(migration.sql).digest("hex"),
}));

export function runMigrations(database: Database): MigrationResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const existingRows = database
    .query("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ checksum: string; version: string }>;
  const existing = new Map(existingRows.map((row) => [row.version, row.checksum]));
  const applied: string[] = [];

  const applyMigration = database.transaction((migration: (typeof migrations)[number]) => {
    database.exec(migration.sql);
    database
      .query(
        `
          INSERT INTO schema_migrations (version, name, checksum, applied_at)
          VALUES (?1, ?2, ?3, ?4)
        `,
      )
      .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
  });

  for (const migration of migrations) {
    const currentChecksum = existing.get(migration.version);
    if (currentChecksum) {
      if (currentChecksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for ${migration.version}. Expected ${migration.checksum} but found ${currentChecksum}.`,
        );
      }
      continue;
    }

    applyMigration(migration);
    applied.push(migration.version);
  }

  return {
    applied,
    currentVersion: migrations[migrations.length - 1]?.version ?? "0000",
    totalApplied: existing.size + applied.length,
  };
}

export function runSpecificMigrations(database: Database, versions: string[]) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applyMigration = database.transaction((migration: (typeof migrations)[number]) => {
    database.exec(migration.sql);
    database
      .query(
        `
          INSERT INTO schema_migrations (version, name, checksum, applied_at)
          VALUES (?1, ?2, ?3, ?4)
        `,
      )
      .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
  });

  for (const version of versions) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (!migration) {
      throw new Error(`Unknown migration version: ${version}`);
    }
    applyMigration(migration);
  }
}
