# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.54

#### Commit
`46f36803`

#### Released at
`2026-09-25T23:28:01Z`

#### Title
Windows installs work again

#### One-line summary
Windows desktop installers can be published again, and `openwork-server web` can install its engine on Windows machines with Git Bash's tar on PATH.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5366 | desktop users | Included | Windows desktop installers publish again, and web installs can unpack the engine on Windows |

#### Behavior changes and removals
- Windows release builds can unpack the OpenCode engine again, and `openwork-server web` can install it on Windows machines with Git Bash's tar on PATH.

#### Lines of code changed since previous release
32 lines changed since `v0.18.53` (26 insertions, 6 deletions).
