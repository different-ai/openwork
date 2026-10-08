---
name: get-started
description: Help the user start using OpenWork after installing the plugin. Use when the user runs OpenWork setup or asks what OpenWork can do in this conversation.
---

# Get started with OpenWork

1. Call `list_skills` without a query. If OpenWork asks the user to sign in,
   wait until they finish, then call it again.
2. Tell the user how many skills are available and list up to ten by title with
   a one-line description each. If there are none, say that their organization
   has not shared skills with them yet, and that skills they save here stay
   private until they share them in OpenWork.
3. Offer two next steps: use one of the listed skills for a task, or save a
   procedure from this conversation as a new skill.
4. If the user needs a different OpenWork organization, explain that they need
   to disconnect OpenWork in the plugin settings and connect again to pick
   another organization.

Do not claim that a skill ran or was saved unless a tool result confirms it.
