# embedded-runtime-config-listener-lifecycle — stopped servers release runtime config listeners

1. An embedded OpenWork server is stopped and another server starts against the same runtime database. Updating the stopped server's workspace can no longer rewrite the active server's generated OpenCode config.

2. Repeating the active server's provider configuration is now a true no-op. OpenWork reports that nothing changed and skips the OpenCode reload.
