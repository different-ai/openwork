# bootstrap-config-debug — Bootstrap config diagnostics and organization server proof

This proof uses an isolated desktop instance, so the bootstrap file shown here is a temporary eval file rather than the user's real OpenWork configuration.

1. Alex opens Settings and goes to Advanced. At the bottom, Developer mode is visible, and turning it on adds the Debug tools to the settings sidebar.

2. Alex opens Debug. A new Bootstrap config section appears with the desktop bootstrap path and the JSON diagnostics, including the baseUrl the app read from the temporary config.

3. Alex stays in Advanced, enters an organization server URL, and saves it. The Organization server section now shows that custom server as the current server.

4. Back on Debug, the Bootstrap config diagnostics now show the saved URL together with a writtenAt timestamp, proving the desktop bootstrap file was stamped and persisted.

5. Alex returns to Advanced and clears the server configuration. The Organization server section returns to standard OpenWork Cloud, and the temporary bootstrap file is gone without resetting workspaces.
