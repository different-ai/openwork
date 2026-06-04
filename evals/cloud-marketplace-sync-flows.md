# Cloud marketplace sync flows

End-to-end user flows for organization marketplace and plugin sync from Den to
the desktop workspace.

## Preflight

1. Start Daytona Den server and Electron sandboxes.
2. Sign the desktop app into Cloud Account.
3. Create a local workspace.
4. Use a Den org where the signed-in user can create plugins and marketplaces.

## Flow 1: Marketplace import with files

**Goal:** A plugin with config objects is published to a marketplace, imported
from desktop, and materializes files/config in the workspace.

### Setup

Through Den API:

1. Create a plugin with a recognizable name.
2. Create at least one config object, such as a skill or command, with raw source text.
3. Attach the config object to the plugin.
4. Create a marketplace.
5. Attach the plugin to the marketplace.

### Steps

1. Open Settings -> Extensions.
2. Click `Refresh`.
3. Select the marketplace if needed.
4. Verify the plugin appears under `Available`.
5. Click `Import`.
6. Click reload if prompted.
7. Inspect the workspace config files through the app or filesystem.

### Expected outcome

- The marketplace and plugin are visible in desktop.
- Import succeeds with a non-zero file count.
- The expected skill/command/config file appears in the workspace.
- Reload applies the imported config without losing workspace state.

## Flow 2: Marketplace update sync

**Goal:** Updating a plugin's config object in Den marks the desktop import as
out of sync and re-import updates local files.

### Steps

1. Import a non-empty plugin using Flow 1.
2. Create a new config object version in Den with changed source text.
3. Open Settings -> Extensions.
4. Click `Refresh`.
5. Verify the plugin row shows an update or out-of-sync state.
6. Re-import the plugin.
7. Inspect the local file contents.

### Expected outcome

- Desktop detects the updated plugin.
- Re-import updates the local file contents.
- The imported plugin state records the new version metadata.

## Flow 3: Marketplace plugin removal

**Goal:** Removing a plugin from a marketplace is reflected in desktop.

### Steps

1. Import a marketplace plugin.
2. Remove that plugin from the marketplace through Den API.
3. Open Marketplace settings and click `Refresh`.

### Expected outcome

- The plugin no longer appears as available in that marketplace.
- Previously imported local files are not silently deleted without user action.
- The UI clearly distinguishes local imported state from current marketplace availability.

## Flow 4: Metadata-only plugin import

**Goal:** A plugin with zero files imports without crashing and reports a clear
zero-file result.

### Steps

1. Create a plugin without config objects.
2. Attach it to a marketplace.
3. Open Marketplace settings and import it.

### Expected outcome

- Import succeeds or returns a clear no-files message.
- UI does not show a false non-zero file count.
- No unexpected workspace files are created.

## Flow 5: Marketplace refresh timing

**Goal:** Measure how fast a newly published marketplace/plugin appears in the
desktop Marketplace tab.

### Steps

1. Open Marketplace settings.
2. Create a marketplace and plugin through Den API.
3. Attach the plugin to the marketplace.
4. Click `Refresh`.
5. Poll CDP until both names are visible.

### Expected outcome

- Manual refresh should reveal the marketplace and plugin within a few seconds.
- Record the duration in the eval report.
