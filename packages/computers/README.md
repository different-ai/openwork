# @openwork/computers

- `projectComputer` turns a remote device record into a computer.
- `decide` checks a source, target and action against a policy snapshot without doing I/O.
- `refusal` describes a refusal from its code, target label and action without rechecking policy.
- `createComputers` lists known computers and calls a supplied executor only for an allowed action on an online target. It does not execute same-computer actions.

Cross-computer work needs all three layers to allow it: the organization, the target's owner and a grant for the source. A grant covers only the target's sandbox and the folders shared with that source.

Validate actions and grants with `@openwork/types/den/computers` before deciding. The working directory check compares path segments, not filesystem entries. The executor must enforce the sandbox against the actual filesystem.
