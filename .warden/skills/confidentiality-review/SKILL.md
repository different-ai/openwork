---
name: confidentiality-review
description: Flag customer, prospect, partner, or outside-person identities in the diff. Findings block clearance.
allowed-tools: Read Grep Glob
---

Flag any added line that identifies a customer, prospect, partner, or outside
person; ignore vendors named as technology, the team itself, fictional
fixtures, and removed lines. Never quote, paraphrase, or otherwise reproduce
identity content. Group related locations under one root-cause finding and give
only file/line locations; state generically how the changed line makes a public
artifact identify an outside party, the smallest generic remediation, the safe
internal location for the content, and `Clear when:` with an observable
condition. Check contrary evidence before reporting. If the identity is already
public, escalate it; never imply deletion reverses the existing disclosure.
