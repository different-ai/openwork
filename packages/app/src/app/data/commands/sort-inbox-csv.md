---
name: sort-inbox-csv
description: Create or sort a CSV file in the worker inbox
seedFiles:
  - path: "contacts.csv"
    content: |
      Name,Email,Role
      Zack,zack@example.com,Admin
      Alice,alice@example.com,User
      Bob,bob@example.com,Editor
      Charlie,charlie@example.com,User
---

Open the `contacts.csv` file in `.opencode/openwork/inbox`, sort it alphabetically by the first column, and save the result.
