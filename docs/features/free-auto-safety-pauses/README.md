# Free Auto safety pauses

- **Status:** always on; `freeAutoSafetyPauses` was retired in November 2026.

A platform administrator can PUT a safety identifier, an expiry (1 to 168 hours) and a reason code to `/v1/admin/free-auto/safety-pause`. Use zero hours to release it. Changes take effect at the next free dispatch across gateway replicas. An IP-based guest identifier can represent several people. Use a short expiry for guests and renew after review. Requests already dispatched may complete.
