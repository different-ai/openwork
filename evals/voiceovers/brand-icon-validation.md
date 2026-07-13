# brand-icon-validation — A bad Icon URL fails loudly in the dashboard; a real logo link just works

Builds on the org brand-icon feature. Today the desktop app validates the Icon
URL silently on each member's machine, so an owner who pastes a non-image link
sees nothing and assumes it worked. This makes the save itself validate the
image server-side and show the owner exactly why a bad URL was rejected — and
confirms a real logo CDN link (the kind that used to silently fail before this
change) sails through and reaches the app.

1. I'm an org owner in Brand Appearance, and I paste a link that isn't a direct image — a normal web page URL — into the Icon URL field.

2. I hit Save, and instead of a silent non-result the dashboard tells me plainly: that link didn't return an image — some logo CDNs redirect hotlinks to a web page — use a direct image URL.

3. I swap in a real logo CDN link — the kind that used to silently fail — and Save again — this time the dashboard confirms the settings were updated, no error.

4. On a teammate's running desktop app, the icon they now see is that company logo — the good URL made it all the way to the OS app icon.
