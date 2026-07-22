# Cloud plugin MCP warning path retired

This demo used to prove local marketplace import warnings. It now proves the retired path stays retired: Den marketplace plugins are shown as cloud-delivered, so malformed bundles cannot partially install local files from the desktop marketplace.

1. I’m signed in to the local Acme cloud org and open the Extension Marketplace. Two fresh org plugins are visible side by side: one intentionally broken MCP bundle and one valid Linear MCP bundle, both marked as running in the cloud.

2. I open the broken bundle first. The old Add action is gone, the row is Active · runs in cloud, and no local warning or partial skill import happens.

3. I check durable local state after viewing that bundle. The broken skill was not installed and the MCP settings page has no broken server row, because viewing cloud-delivered marketplace content is non-destructive.

4. I open the valid bundle next. It also stays Active · runs in cloud with no Add action, and the Linear MCP is not written into local MCP settings from the marketplace UI.
