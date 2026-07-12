# den-sync-coalesce — Den settings changes are not dropped during provider sync

1. A cloud-provider reconciliation is already running when OpenWork receives a Den settings change, such as selecting another organization.

2. Instead of dropping the event because a request is in flight, OpenWork records one pending synchronization for the newest settings state.

3. When the current request settles, exactly one follow-up pass runs immediately; several settings events during the same request coalesce instead of creating overlapping network calls.

4. Signing out or unmounting cancels the pending pass, while a failed request still releases the queue so the latest valid state can be reconciled without a retry loop.
