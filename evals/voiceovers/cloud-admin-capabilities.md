# Cloud admin capabilities from any MCP app

This internal demo proves that platform admins can use Den admin capabilities through the existing OpenWork Cloud connection, without configuring a separate local admin MCP.

1. I connect an MCP app to OpenWork Cloud and search for the Den admin overview. Because I am an allowlisted platform admin, the existing capability search returns the namespaced admin tool.

2. I execute that exact capability through the same OpenWork Cloud connection. The response identifies the Den admin toolset, proving admin operations travel through the normal search-and-execute rail.

3. I repeat the search as an ordinary member. No admin capability is discoverable, and a direct execution attempt is rejected as unknown, so the platform-admin boundary remains intact.

4. I inspect the desktop connection catalog. OpenWork Cloud remains available, while the separate hidden OpenWork Admin connector is gone because no local admin connection is needed anymore.
