# windows-organization-install-branding — Organization branding replaces stale Windows install identity

1. A Northwind teammate extracts the organization download and runs the standard signed Windows installer beside its setup file.

2. On first launch, the app connects to Northwind's configured server and appears with the Northwind name and icon, without exposing a stale OpenWork shortcut as the user-facing entry.

3. In Windows Search and the Start Menu, the installed app is listed as Northwind with the organization icon, and launching it opens the same configured desktop.

4. An existing OpenWork installation upgrades through the same organization package. Its shortcut converges to Northwind branding while its existing on-prem server configuration remains intact.

5. After another launch, Windows Search, Start Menu, taskbar, and Alt-Tab consistently show Northwind; uninstall removes the managed shortcuts cleanly without leaving duplicate organization or OpenWork entries.
