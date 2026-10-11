---
name: openwork-connect
description: Search and use the skills, MCP connections, and connected services available through the user's OpenWork organization.
---

# OpenWork Connect

Use the OpenWork MCP server when the user asks for an organizational skill,
shared MCP tool, connected service, or OpenWork Cloud operation.

## Skills

1. Call `list_skills` to see every skill the member may use; no keywords are
   needed. Pass `query` only to narrow a long catalog.
2. Call `get_skill` with the skill's name or exact capability, read the whole
   returned SKILL.md, then follow it.
3. When the user names a specific skill or asks whether it exists, verify that
   requested reference with a fresh `get_skill` call. Search results rank keyword
   relevance: a returned capability is an exact invocation reference, not proof
   that the user's requested name exists. A filtered catalog also is not an
   exact-name lookup. Do not use a prior brief or relabel a loose match as the
   requested skill.
4. If the exact reader returns `unknown_skill`, report that the requested skill
   is unavailable to the current member. Do not execute, invent, automatically
   create, or silently substitute another skill, and do not reconnect for a
   missing reference. Offer alternatives only as explicitly named alternatives.
   If direct readers are unavailable, state that exact identity is unverified.

## Workflow

1. Call `search_capabilities` with a short description of the outcome unless
   the exact capability name is already available in the current context. Use
   keyword variants to discover an outcome, not to claim a named item exists
   after its exact reader has refused it.
2. Select an exact capability name from the search result only when the
   returned identity and described behavior actually fit the requested outcome.
   Do not execute a loose match to replace a specifically named unavailable item.
3. Call `execute_capability` with that exact name and only the parameters
   required for the requested outcome.
4. If OpenWork returns a connection, authentication, permission, or admin
   setup state, relay that state and its next action accurately. Do not claim
   that an unavailable capability ran.

Search results reflect the signed-in member's organization, grants, teams, and
connection readiness. Do not infer access from a capability that was visible
in another organization or an earlier authorization context.

OpenWork Connect performs OAuth through the MCP client. Never request, embed,
or persist OpenWork access tokens in plugin files or chat content.
