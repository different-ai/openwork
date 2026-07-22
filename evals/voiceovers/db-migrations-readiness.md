# db-migrations-readiness — Den migrations run from precompiled production code

1. Here’s the Den deployment image with its database schema and committed Drizzle migrations already prepared at build time.

2. When the Helm migration job starts, it runs a lightweight, precompiled Drizzle ORM migration runner—without tsup, declaration generation, tsx, or drizzle-kit.

3. On a fresh database, bootstrap establishes the current schema and migration baseline; on an existing database, only pending migrations run.

4. The job finishes by ensuring required FULLTEXT indexes, using substantially less memory and preserving the existing migration behavior.
