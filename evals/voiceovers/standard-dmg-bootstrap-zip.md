# standard-dmg-bootstrap-zip — Organization downloads reuse the standard signed Mac installer

1. An organization administrator opens organization downloads. Install links are available by default, while platform admins retain an org-level kill switch.

2. A signed-in organization member opens the dashboard and sees the download intended for their organization. Users without an organization install link continue to get the ordinary OpenWork download experience.

3. The member downloads one ZIP containing only the standard signed OpenWork DMG and the organization's `desktop-bootstrap.json`. There is no separate OpenWork installer application to build or maintain.

4. The member extracts the ZIP and opens the normal OpenWork DMG. OpenWork recognizes the bootstrap configuration packaged beside it and uses it during first launch.

5. After the standard macOS installation, OpenWork starts connected to the correct organization deployment with its configured name, wordmark, and app icon. The member still signs in normally; this change does not introduce mandatory sign-in.

6. If organization downloads are disabled by the org kill switch, OpenWork never generates or exposes the organization ZIP. Otherwise, the same ZIP flow is available by default on every deployment.
