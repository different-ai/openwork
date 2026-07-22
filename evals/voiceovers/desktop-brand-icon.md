# desktop-brand-icon — Your org's icon follows the app onto the OS taskbar and dock

Builds on white-label desktop policies. The existing Logo URL (`brandLogoUrl`,
the wide wordmark) keeps branding the sidebar inside the app; a new Icon URL
(`brandIconUrl`, a square PNG) drives the OS-level app icon — Windows taskbar,
macOS Dock, Linux window — applied live, cached locally, and re-applied on
every boot so app updates are a non-event. Proof runs against a real Den
server and the Electron app on Daytona (Linux/X11); the same Electron call
paths cover Windows (`win.setIcon`) and macOS (`app.dock.setIcon`).

1. I'm an org owner in the Den dashboard, and under Brand Appearance there's a new field next to our logo: Icon URL, for a square PNG.

2. I paste our icon's URL and save — settings confirm the change applies to everyone in the org.

3. On a teammate's desktop the app is just running — and within moments its icon in the taskbar switches from the OpenWork mark to our company icon, no restart needed.

4. Inside the app nothing is lost: the sidebar still shows our full logo — the wide wordmark — exactly as before.

5. I quit and relaunch the app, and it comes back already wearing our icon from the very first frame — before sign-in even finishes.

6. Back in the dashboard I clear the Icon URL, and the running app's icon returns to the stock OpenWork mark on its own.
