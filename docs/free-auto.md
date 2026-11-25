# Free Auto for organizations

Signed-in free Auto is on for every organization whenever the deployment master switch is on. There is no per-organization enrollment. Both Den and Gateway check eligibility for issuance, status and each new request, including requests with previously issued keys.

- `INFERENCE_FREE_ENABLED=false` is the global kill switch (the default). Set it to `true` on both Den API and Gateway to serve free Auto.
- An organization can still opt out: an admin turning off the free starter model in **Who can use models** (desktop policy `allowZenModel`), or turning OpenWork Models off (`inferenceFree.offerAllowed:false`), stops its members from getting Auto.
- DPA restrictions and the weekly person-wide allowance still apply. Organizations with an OpenWork Models subscription get Auto too, from each member's free allowance, and are never billed for it.
- Signed-out desktop access remains controlled by `ANONYMOUS_INFERENCE_ENABLED`; it has no organization.

Older deployments may have stored `metadata.inferenceFree.rolloutEnabled` on organizations. It is now ignored, so an organization a platform administrator previously turned off gets free Auto like every other organization.

## Who OpenAI sees

Free Auto runs on one OpenAI key for everyone, so each request carries a `safety_identifier` that names its end user to OpenAI. OpenAI can then report or limit that one person instead of the whole key.

- The Gateway sets it from the authenticated principal. A `safety_identifier` or `user` sent by the caller is dropped.
- It is the `principal_hash` stored on that person's usage rows: one value per signed-in person (across their organizations), per signed-out machine, or per IP for a request with no desktop proof. It contains no name, email or address.
- When OpenAI names an identifier, find its requests with `principal_hash = '<identifier>'` in `inference_free_usage` (signed-in; the row has the organization and member) or `anonymous_inference_usage` (signed-out).
- Free Auto failure logs carry `safety_identifier`, so requests OpenAI refuses for one identifier can be told apart from an outage.

Requests with no desktop proof are limited by IP only. `ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD=0` on the Gateway turns them off, along with builds that have no release tag; signed-out access then requires a proof-capable release.

## Limits and safeguards

These always apply. They are settings, not feature flags.

| Safeguard | Setting |
| --- | --- |
| Each person's weekly allowance, across their organizations | `INFERENCE_FREE_WEEKLY_BUDGET_USD` on Den and Gateway |
| One weekly pool per organization, and one per founding account across every organization it created | `INFERENCE_FREE_ORG_WEEKLY_MICRO_USD` (default $25) |
| A daily ceiling on all signed-in free usage | `INFERENCE_FREE_MEMBER_GLOBAL_DAILY_MICRO_USD` (default $350). Keep it above normal daily spend: when it is reached, every member is refused until midnight UTC. |
| Signed desktop required | `DESKTOP_FREE_MIN_VERSION` on the Gateway. Unset means no proof is required. Once it is set, members and guests need a signed request from that release or newer, older desktops are told to update, and accounts on one desktop share one personal-sized weekly allowance. Set `WORKBOT_FREE_GRANT_SECRET` on Den and every Gateway first; the Gateway refuses to start without it, so hosted Workbot keeps free models. |
| Safety pauses, safety cases and funded-model suspensions | Recorded by platform administrators; enforced from the next request. See [safety notices](features/free-auto-safety-cases/README.md) and [account suspensions](features/funded-model-account-suspensions/README.md). |

Each request reserves the cost of the largest single completion until its usage receipt arrives. An organization with no recorded founder uses its own weekly pool. A failed funded-model suspension lookup is logged and the request continues.
