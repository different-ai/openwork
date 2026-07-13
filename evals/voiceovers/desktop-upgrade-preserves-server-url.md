# desktop-upgrade-preserves-server-url — Desktop upgrades preserve the organization server

The Daytona end-to-end evidence uses the fictional organization “Example Manufacturing” and contains no customer names or server details.

1. This Windows desktop installation is connected to Example Manufacturing’s on-prem OpenWork server, and its organization URL is recorded in the desktop-bootstrap configuration.

2. I install the latest desktop version over the existing installation, following the same upgrade path that previously caused the app to lose its server.

3. When OpenWork launches after the upgrade, it reconnects to the configured on-prem server—not a stale, default, or cloud URL.

4. I fully quit and restart the desktop app, and the organization server remains selected, proving the configuration persists beyond the first upgraded launch.

5. I repeat the flow through the alternate reinstall/update path, matching the two reported outcomes, and the desktop-bootstrap URL still takes precedence.

6. Finally, with cloud access unavailable, OpenWork continues using the on-prem URL without attempting to replace it, preserving support for air-gapped deployments.
