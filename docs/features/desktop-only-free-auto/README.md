# Desktop-only free models

- **Status:** controlled by `DESKTOP_FREE_MIN_VERSION`; `desktopOnlyFreeAuto` was retired in November 2026.

Release a proof-capable desktop first, then set `DESKTOP_FREE_MIN_VERSION` on the gateway to that release. From then on, members and guests need a signed request. A supported desktop answers the gateway challenge with an OS-protected installation key and release tag. The challenge is HTTP 426 `desktop_update_required` with `desktopProof: "required"`, so released desktops that cannot sign show an update prompt that names the minimum version. OpenWork Web and other servers without the desktop signer report free models as desktop-only. Each proof covers the request and expires within the replay window. Accounts on one desktop share one personal-sized weekly allowance.

Hosted Workbot keeps free Luna because Den and every gateway share `WORKBOT_FREE_GRANT_SECRET` (at least 32 characters, distinct from the other Free Auto secrets): Den signs a two-hour grant bound to the member's key and organization, and the gateway accepts it in place of desktop proof. The gateway refuses to start with a minimum version and no grant secret. A shared release tag can be recovered from a distributed binary. The protocol raises the cost of casual API use and does not provide hardware attestation.
