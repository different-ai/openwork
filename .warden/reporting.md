# Warden measurements

Each attempted review writes a compact GitHub Actions job summary: result,
analysis duration, and elapsed time through summary creation. Skill durations
and actionable security findings sit in a collapsed details section. There
are no PR comments or review-thread mutations. Confidentiality finding text
and paths are omitted; reviewers inspect the added diff privately.

One `warden-summary` artifact retains `warden-summary.json` for 90 days. Its
version 2 record contains:

- Repository, PR number, head/base commits, run ID, run attempt, and timestamp.
- Analysis outcome, completeness, findings counts, and fixed reason codes.
- `timing.analysis_ms`: elapsed time from immediately before the analyzer
  until reporting begins.
- `timing.review_to_summary_ms`: elapsed time from the job's first step until
  reporting begins, including checkout/setup. Queueing and artifact upload
  are excluded. Both wall-clock measurements have one-second start precision.
- Per-skill duration in milliseconds and counts by severity. Skills run
  concurrently, so their durations must not be summed into wall time.

Missing measurements use `null`. An incomplete run can retain observed
findings counts, but they are not final totals. `blocking_count` is retained
for old receipt consumers and is `null` unless analysis is complete. This
artifact is observation data, not merge approval authority.

Measurements contain no PR titles, authors, branch names, finding IDs, finding
text, file paths, model error text, or source snippets. The detailed run summary
is separate from the machine-readable measurement. Native analyzer output is
not uploaded as an artifact.

An `always()` reporting step records failures or missing/malformed analysis
when the trusted reporter is available. Cancellation, runner loss, or failure
before trusted checkout may prevent any artifact; missing runs are unknown,
never zero. No timing collection failure grants a clean review.

## Extending tracking

Use `(repository, run_id, run_attempt)` as the stable row key. A future collector
can enumerate **all** Warden runs through the Actions API, retain their outcome
and job/step timestamps, then join available artifacts. That includes missing
measurements, queue time, complete job time, cancellation, and retries without
adding another PR bot or storing hidden state in comments. Persist those rows
before the 90-day artifact expiry for longer-term trends.

Add measured cost/token fields or additional workflow collectors to the same
versioned schema when needed. Precision and time-to-fix need actual adjudication
and resolution events; they are not inferred from these counts. This setup does
not yet provide an all-workflows collector or a permanent metrics database.

The analyzer schema and trusted base-config behavior are pinned to Warden
[0.43.0 source](https://github.com/getsentry/warden/tree/8759014a14130cd2b82e59d3fb450a7385721221).
