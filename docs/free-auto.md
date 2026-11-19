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

Requests with no desktop proof are limited by IP only. `ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD=0` on the Gateway turns them off, along with builds that have no release tag; official desktop releases keep signed-out Auto.
