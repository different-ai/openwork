# demo-electron-fresh-folders — launch two isolated demos with fresh data

1. I run `pnpm demo:electron`, and two OpenWork demo windows launch together.

2. Each window uses its own newly created temporary folder, completely separate from the production OpenWork data directory.

3. The terminal prints both folder paths, making their isolation easy to verify.

4. When I stop and rerun the command, two fresh folders are created, so neither demo inherits state from the previous run.
