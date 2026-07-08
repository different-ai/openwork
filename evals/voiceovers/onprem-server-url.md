# onprem-server-url — Point OpenWork at your organization's server without an installer

Cast is an enterprise user on a fresh OpenWork install whose IT team runs a
self-hosted OpenWork server. Today aiming the desktop app at that server
requires a custom installer that writes desktop-bootstrap.json, or a hidden
developer-mode field. This makes it a first-class, copy-paste affordance on
the welcome screen and at the top of Advanced settings.

1. On a fresh install, the welcome screen offers more than Get started. Beneath it sits a quiet link that says Using OpenWork on-premises, so an enterprise user sees immediately where to point the app at their company's server before signing in to anything.

2. Clicking it opens a simple dialog titled Connect to your organization's server. The user pastes the address exactly as IT shared it and saves.

3. The welcome screen now shows it is connected to the organization's server, so everything that follows, from sign-in to cloud features, talks to the company's OpenWork instead of the public cloud.

4. Later, in Settings, Advanced shows an Organization server section right at the top with no developer mode required. The same address is visible there and can be changed with one copy-paste.

5. One click on Reset returns the app to standard OpenWork Cloud, proving there is no hidden state left behind and the welcome flow and the settings field stay in agreement.

6. When an organization requires sign-in before anything else, the same on-premises option sits right on the sign-in screen, so pointing the app at the company server never depends on developer mode.
