# control-pane-extensions-action-removed — One settings path, no duplicate shortcut

Agents and voice drive OpenWork through the control pane: the list of UI actions exposed to controllers. It used to offer two ways to open Extensions settings — a dedicated "Open MCP and extension settings" action (`route.settings.extensions`) and the generic "Open a settings panel" action (`settings.panel.open` with panel "extensions"). This demo shows the duplicate dedicated action is gone from the pane and the generic action still lands on the Extensions screen.

1. The control pane still offers the route shortcuts and the generic Open a settings panel action. But the duplicate extensions entry — route dot settings dot extensions — is no longer listed.

2. Nothing is lost. Running settings panel open with the extensions panel still walks the app straight to Settings and lands on the Extensions screen.
