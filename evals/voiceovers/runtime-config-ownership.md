# runtime-config-ownership — one managed file, one direction, the same result every time

Today OpenWork's engine config is two-way and guessy: some settings changes
write into the managed runtime file, others write through the engine into
the user's personal OpenCode files, and old versions left untraceable
leftovers behind (field incident: a stale Cloud MCP URL "from an old
version" no screen could explain). After this change there is exactly one
writer and one direction: runtime DB → managed runtime config file → engine.
OpenWork treats the user's personal config as read-only, and a one-time
migration moves OpenWork-written leftovers out of personal files into the
managed file, with a backup.

1. When something looks wrong with my agent's config today, I have to guess — changes land partly in OpenWork's managed file and partly in my personal OpenCode files, and old versions left ghosts in both.

2. After the update, managed state flows one way only: OpenWork writes a single runtime file it owns, my personal config becomes read-only to the app, and a one-time migration moves the old leftovers over — with a backup and a notice showing exactly what moved.

3. I flip a provider off, restart the app, and check again: my personal config is byte-for-byte untouched, and the managed file rebuilds to exactly the same state every time.

4. Debug settings now shows the whole story on one card: the managed file's exact contents, when it was last rebuilt, and the one rule that makes it predictable — one writer, one direction.
