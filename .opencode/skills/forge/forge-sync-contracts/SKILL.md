---
name: forge-sync-contracts
description: Use when merging delta contracts from a Forge track into the main contracts without archiving the track.
---

# Forge Sync Contracts

## Overview

Apply delta contracts from a Forge track into main contracts with intelligent merging.

**Core principle:** Preserve existing contract content not mentioned in the delta.

## When to Use

- User wants to update main contracts without archiving
- As a step inside forge-archive or forge-bulk-archive

**Do not use when:** The track has no delta contracts.

## Delta Sections

- `## ADDED` -> new requirements
- `## MODIFIED` -> update existing requirements/scenarios
- `## REMOVED` -> delete requirements
- `## RENAMED` -> rename requirement headings (FROM/TO)

## Steps

1. **Select the track**
   - If unclear, prompt for selection from `forge/tracks/`

2. **Locate delta contracts**
   - `forge/tracks/<change>/contracts/<domain>/contract.md`

3. **For each domain**
   - Read delta contract and main contract at `forge/contracts/<domain>/contract.md`
   - Apply changes:
     - ADDED: append if missing; update if already exists
     - MODIFIED: patch only specified parts, preserve other scenarios
     - REMOVED: delete requirement block
     - RENAMED: rename heading

4. **Create missing main contract**
   - If none exists, create with a brief Purpose and Requirements section

5. **Summarize changes**
   - List domains updated and requirement changes

## Idempotency

Running this twice should produce the same result. Do not duplicate requirements or scenarios.

## Output Format

```
## Contracts Synced: <change>

Updated domains:
- <domain>: added X, modified Y, removed Z
```

## Common Mistakes

- Overwriting entire contracts instead of patching
- Losing existing scenarios not referenced in delta
- Failing to create missing main contracts
