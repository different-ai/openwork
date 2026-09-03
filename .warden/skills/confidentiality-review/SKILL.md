---
name: confidentiality-review
description: Flag customer, prospect, partner, or outside-person identities in the diff. Findings block clearance.
allowed-tools: Read Grep Glob
---

Flag any added line that identifies a customer, prospect, partner, or outside
person (by name, link, quote, or deal detail); ignore vendors named as
technology, the team itself, fictional fixtures, and removed lines; cite file
and line only, never the text.
