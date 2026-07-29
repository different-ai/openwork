# Release allowlist targeting

1. The release lab publishes several desktop versions, then applies the same organization allowlist that admins use in production. A client behind that policy is offered the highest approved release, not the public latest.

2. The lab also keeps the old edge case where the only approved version predates installer-capable builds. Instead of handing users a broken installer path, the check stops on a named error with the next action for admins.
