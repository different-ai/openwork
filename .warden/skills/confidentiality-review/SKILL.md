---
name: confidentiality-review
description: Flag customer, prospect, partner, or individual identities that this diff would publish in a public repository. All findings gate Warden clearance.
allowed-tools: Read Grep Glob
---

Report a HIGH finding for any added line that names, quotes, or describably
identifies a customer, prospect, partner, or person outside the OpenWork team
(organization, individual, Slack/Notion/Linear link, quoted end-user text, deal
facts); ignore public vendors referenced as technology, the team itself,
clearly fictional fixtures, and removed lines; cite only file and line and
never repeat the identifying text.
