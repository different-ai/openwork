# managed-brand-asset-uploads — Example Corp branding stays inside its deployment

This proof covers Den-managed wordmark and square-icon uploads for an on-prem deployment. It does not change the desktop display name or add Windows-specific taskbar behavior.

1. An Example Corp owner uploads the supplied wordmark and square icon directly instead of finding public URLs.

2. OpenWork previews both files and validates their format, dimensions, and intended use.

3. If the owner's sign-in is no longer recent, saving opens a clear security check instead of exposing a raw server error.

4. The owner verifies once, and OpenWork resumes the pending upload automatically without making them choose the files again.

5. The saved assets are now available to every member through the Example Corp deployment.

6. A teammate’s desktop loads the branding without contacting a public image CDN.

7. Replacing an image produces a versioned asset, so desktops receive the new bytes instead of stale cache.

8. Clearing the assets restores default branding.
