# single-org-invite-beyond-free-seats — Self-hosted workspaces are never capped at five members

This user-facing demo follows Alex, the admin of a self-hosted single-org OpenWork deployment. The workspace already has more members than the hosted free tier, which used to dead-end every new invite behind a seat-billing paywall the operator could never resolve.

1. Alex opens the Members page of the self-hosted Acme workspace. The roster already counts well past five people, and the billing summary confirms this deployment has no seat billing configured at all.

2. Alex clicks Add member and invites a brand new teammate. The invite lands as a pending row right away — no paywall, no subscribe dialog, nothing asking for a credit card.

3. Behind the scenes the invitation endpoint now answers created instead of payment required, so every additional invite keeps working. Self-hosted single-org deployments have no member cap.
