# Release feed degraded

1. First the artifact host behaves like GitHub during a propagation lag and returns 504. The lab proves that this becomes a clear propagation error instead of a quiet no-update.

2. Next the version feed is intentionally stale, just like the thirty-minute cache lag seen in the field. The lab names the stale cache and tells the operator how to force fresh release metadata.

3. Finally the download host is denied by enterprise outbound policy. The check reports the blocked host and the allowlist or mirror action needed before users try another reinstall.
