# @openwork/computers

- `projectComputer` turns a remote device record into a computer.
- `signedInApp` represents an OpenWork app signed in as a member, without identifying a specific device.
- `computerState` returns a state for display. Member machines show Online or Offline. Cloud computers show Ready, Starts when needed or Has a problem.
- `matchComputers` looks for a case-insensitive exact label first. Otherwise it returns every label containing all the search words. The caller handles no matches or asks which computer to use when several match.
- `decide` checks a source, target and action against a policy snapshot without doing I/O.
- `refusal` describes a refusal from its code, target label and action without rechecking policy.
- `insideSharedFolder` checks whether an absolute POSIX path is a shared folder or a descendant. It does not resolve filesystem entries.
- `createComputers` lists known computers and calls a supplied executor for allowed cross-computer work. The executor handles reaching or starting cloud computers regardless of their last reported availability. Member machines must report `online` for remote execution. Same-computer actions do not use this executor.

Cross-computer work needs all three layers to allow it: the organization, the target's owner and a grant for the source. An exact computer grant takes priority over an owner grant, which takes priority over a Workbot grant. An owner grant covers member machines signed in as the target's owner. The winning grant covers only the target's sandbox and the folders it shares. An explicit path outside those folders is refused rather than checked against another grant.

Validate actions and grants with `@openwork/types/den/computers` before deciding. Shell working directories and paths for reads, writes, lists and searches use the same containment check. The executor must enforce the sandbox against the actual filesystem.
