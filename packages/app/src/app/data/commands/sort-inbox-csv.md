---
name: sort-inbox-csv
description: Create or sort a CSV file in the worker inbox
---

Open the worker inbox at `.opencode/openwork/inbox/` inside this workspace.

Goal: open a CSV file and reorder its rows in alphabetical order.

Requirements:
1. If there is no CSV file in `.opencode/openwork/inbox/`, create a small sample CSV there first.
2. Open the CSV file from the inbox, sort the rows alphabetically by the first data column unless the file clearly suggests a better key, and save the updated CSV back into the inbox.
3. Keep the result easy to inspect and tell me exactly which file you used.
4. Finish by showing the final row order and the saved inbox path.
