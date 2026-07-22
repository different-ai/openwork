# cloud-signin-go-to-dashboard — Signed in? "Go to dashboard" actually goes

Cast is Alex (org admin) in OpenWork Cloud (den-web). The desktop app sends
him to the cloud sign-in page with a desktop handoff (`?desktopAuth=1`) while
he already has a session. The page shows the signed-in card with an escape
hatch back to the web dashboard — a button that used to do nothing, because
the landing-route resolver refused to resolve during a desktop handoff. This
demo proves the click now lands on the dashboard.

1. Alex is already signed in when the desktop app bounces him to the cloud sign-in page. Instead of a password form he gets the signed-in card: open the desktop app, copy the sign-in link, or head back to the dashboard.

2. He clicks Go to dashboard, and it actually goes: the sign-in page hands him straight to his org dashboard — no dead click, no retyping his password.
