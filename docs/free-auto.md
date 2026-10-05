# Free Auto for organizations

Signed-in free Auto is on for every organization whenever the deployment master switch is on. There is no per-organization enrollment. Both Den and Gateway check eligibility for issuance, status and each new request, including requests with previously issued keys.

- `INFERENCE_FREE_ENABLED=false` is the global kill switch (the default). Set it to `true` on both Den API and Gateway to serve free Auto.
- An organization can still opt out: an admin turning off the free starter model in **Who can use models** (desktop policy `allowZenModel`), or turning OpenWork Models off (`inferenceFree.offerAllowed:false`), stops its members from getting Auto.
- DPA restrictions and the weekly person-wide allowance still apply. Organizations with an OpenWork Models subscription get Auto too, from each member's free allowance, and are never billed for it.
- Signed-out desktop access remains controlled by `ANONYMOUS_INFERENCE_ENABLED`; it has no organization.

Older deployments may have stored `metadata.inferenceFree.rolloutEnabled` on organizations. It is now ignored, so an organization a platform administrator previously turned off gets free Auto like every other organization.
