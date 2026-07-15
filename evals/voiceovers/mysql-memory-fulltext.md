# MySQL memory FULLTEXT timestamp proof

Context: Internal fraimz proof for the memory-bank MySQL migration. The frames demonstrate the strict-mode bootstrap and upgrade invariants using database commands and assertions rather than the desktop app.

1. A strict-mode MySQL database starts with the portable timestamp default.

2. Existing memory rows retain their original `created_at` values during migration.

3. The FULLTEXT index is created without relaxing `sql_mode`.

4. Fresh bootstrap and upgrade paths both complete successfully.
