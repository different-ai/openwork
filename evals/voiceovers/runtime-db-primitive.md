# runtime-db-primitive — One safe runtime database foundation for server state

1. The server resolves one runtime database location, including an explicit override, before any domain store opens it.

2. Session groups and workspace configuration persist through the shared database foundation while remaining isolated in their own tables.

3. Runtime OpenCode configuration and cloud plugin installation state use the same connection primitive without sharing or corrupting domain data.

4. After the stores close and reopen, each domain reads back the state it wrote, demonstrating that the refactor preserves durable behavior.
