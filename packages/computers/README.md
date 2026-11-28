# @openwork/computers

- `projectComputer` turns a remote device record into a computer.
- `signedInApp` represents an OpenWork app signed in as a member, without identifying a specific device.
- `computerState` returns a state for display. Member machines show Online or Offline. Cloud computers show Ready, Starts when needed or Has a problem.
- `matchComputers` looks for a case-insensitive exact label first. Otherwise it returns every label containing all the search words. The caller handles no matches or asks which computer to use when several match.
- `uniqueComputerLabel` trims names and adds the first free number when a name is taken, ignoring case.
- `decide` checks a source, target and action against a policy snapshot without doing I/O.
- `refusal` describes a refusal from its code and target label without rechecking policy.
- `computerActionForToolCall` derives the action to authorize from a validated tool call.
- `insideSharedFolder` checks whether an absolute POSIX path is a shared folder or a descendant. It does not resolve filesystem entries.
- `createComputers` lists known computers and calls a supplied executor for allowed cross-computer work. The executor handles reaching or starting cloud computers regardless of their last reported availability. Member machines must report `online` for remote execution. Same-computer actions do not use this executor.

Personal computers accept work only from the same owner, after the organization and target owner allow it. An exact computer grant takes priority over a Workbot grant, which only matches Workbot. Generic owner grants do not apply to personal targets. The winning grant must share at least one sandbox folder; writing requires a folder explicitly shared for editing. A path outside the winning grant is refused rather than checked against another grant. Registered VMs still require explicit whole-computer access and only accept work from their owner's signed-in OpenWork apps.

Validate actions and grants with `@openwork/types/den/computers` before deciding. Shell working directories and paths for reads, writes, lists and searches use the same containment check. The executor must enforce the sandbox against the actual filesystem.
