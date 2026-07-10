# managed-brand-asset-uploads — Example Corp branding stays inside its deployment

This proof covers Den-managed wordmark and square-icon uploads for an on-prem deployment. It does not change the desktop display name or add Windows-specific taskbar behavior.

1. An Example Corp owner uploads the supplied wordmark and square icon directly instead of finding public URLs.

2. OpenWork previews both files and validates their format, dimensions, and intended use.

3. Saving makes the assets available to every member through the Example Corp deployment.

4. A teammate’s desktop loads the branding without contacting a public image CDN.

5. Replacing an image produces a versioned asset, so desktops receive the new bytes instead of stale cache.

6. Clearing the assets restores default branding.
