# google-workspace-multi-account — Two Google domains, one person, no wrong inbox

Cast reuses the Google Workspace demo — Alex (org admin, OpenWork Cloud) and
Jordan (member, desktop) — after Acme Robotics acquires Acme Labs, which runs
its own Google domain. Today a member's Google credential is unique per
`(member, provider)` and the org's OAuth client is unique per `(org, provider)`,
so a second Google domain silently replaces the first. This demo shows Google
Workspace becoming a *connector row* rather than a registry singleton: each
Google domain is its own governed connection, with its own Google app, and each
member authorizes their own account against each one. Because connected
connections already namespace their capabilities as `<connectionId>:<toolName>`,
the agent never has to ask which inbox — it reaches for the connector the user
named. Both Google domains and the consent screen are played by the
protocol-identical mock IdP, so both round trips are real and externally
witnessed without live Google accounts in CI. The final frame proves the
single-domain experience is unchanged.

1. Alex runs IT for Acme Robotics, and Google Workspace is already set up for the whole company. Then Acme acquires Acme Labs — a second Google domain, with its own Google app that Acme Labs owns and trusts.

2. He adds Acme Labs as its own connector, named so people recognize it. The original Acme Robotics connection sits right beside it, completely untouched.

3. Jordan works in both companies. In her app both Google connectors now appear, each offering the same thing: connect your own account. Nobody hands her a shared password.

4. She connects Acme Labs, and her real browser opens Google's consent screen — which asks her which account to use, instead of quietly reusing the one she's already signed into. She picks her Labs account and approves.

5. Back in OpenWork both connectors read Connected, each showing the real email address behind it. Two sign-ins, both hers, each one revocable on its own.

6. Now she asks her AI coworker to draft the supplier email in Acme Labs. It doesn't guess and it doesn't have to ask — it sees two Google connectors by name and reaches for the right one.

7. The draft is really sitting in her Acme Labs mailbox, and the link she gets opens that account — not whichever Google she happened to sign into first.

8. And for a company with a single Google domain, nothing changed at all: one connector, one Connect button, no new decisions. The second domain is an option, not a tax.
