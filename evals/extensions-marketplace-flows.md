# Extensions marketplace flows

End-to-end user flows for the redesigned Extensions runtime and Marketplace UI.
These are the PR 1 recording baseline.

## Flow 1: Install an extension from Marketplace

**Goal:** A cloud marketplace package installs from Settings -> Extensions -> Marketplace
and appears as an active runtime extension.

Steps:
1. Sign in to OpenWork Cloud with an org that has at least one marketplace package.
2. Create or open a local workspace.
3. Open Settings -> Extensions.
4. Click `Marketplace`.
5. Search for a known package or use the default list.
6. Click `Add`.
7. Return to `My Extensions`.

Expected outcome:
- The package row shows `Add` before install.
- Add succeeds with the existing import/reload toast.
- The imported package appears in `My Extensions` as an active Plugin row.
- The package row in Marketplace changes to `Installed` or `Update available`.

## Flow 2: Empty state when no extensions match

**Goal:** Users get a clear empty state when the current search/filter produces
no extension rows.

Steps:
1. Open Settings -> Extensions -> My Extensions.
2. Search for a random string that should not match any extension.
3. Open Settings -> Extensions -> Marketplace.
4. Search for the same random string.

Expected outcome:
- My Extensions shows `No extensions found` with guidance to change search or open Marketplace.
- Marketplace shows `No marketplace packages match your search or filters.`
- No stale extension rows remain visible under the empty search.

## Flow 3: Uninstall an extension package

**Goal:** A previously installed marketplace package can be removed from the
workspace extension runtime.

Steps:
1. Install a marketplace package using Flow 1.
2. Open Settings -> Extensions -> Marketplace.
3. Find the installed package.
4. Click `Remove`.
5. Open Settings -> Extensions -> My Extensions.

Expected outcome:
- The package row shows `Remove` while installed.
- Remove succeeds and shows a success toast.
- The package leaves `My Extensions`.
- The Marketplace package returns to an installable state.

## Flow 4: Extension CTA states are accurate

**Goal:** Different extension states expose the correct primary action instead
of treating every extension as connected.

Steps:
1. Open Settings -> Extensions -> My Extensions.
2. Inspect built-in enabled extensions such as `OpenWork Browser`.
3. Inspect setup-required extensions such as `OpenAI Image Gen` or `Ollama`.
4. Open Settings -> Extensions -> Marketplace.
5. Inspect available, installed, and update-available packages if present.

Expected outcome:
- Already active entries show connected/active state and a details/configure CTA.
- Setup-required built-ins show a connect/setup CTA, not connected.
- Marketplace available packages show `Add`.
- Marketplace installed packages show `Remove`.
- Marketplace out-of-sync packages show `Update`.

## Flow 5: Filter by marketplace

**Goal:** Marketplace-specific filtering exists but stays out of the primary UI.

Steps:
1. Open Settings -> Extensions -> Marketplace.
2. Open `Filters`.
3. Select a specific marketplace.
4. Clear or change the filter.

Expected outcome:
- Marketplace selection filters the package list.
- Marketplace filtering is in the secondary Filters control, not primary IA.
- Package rows still show marketplace badges for context.

## Flow 6: Search extensions and package contents

**Goal:** Search matches both top-level package/extension fields and package
contents such as installed files/capabilities.

Steps:
1. Open Settings -> Extensions -> Marketplace.
2. Search by package name.
3. Search by description text or capability text such as `skill`, `command`, or `mcp`.
4. Open Settings -> Extensions -> My Extensions.
5. Search by installed plugin name or installed file title after importing.

Expected outcome:
- Marketplace search filters package rows by name, description, marketplace, capabilities, and installed file metadata.
- My Extensions search filters runtime rows including imported marketplace packages.
- Clearing search restores the full list.
