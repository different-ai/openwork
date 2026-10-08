---
name: team-skills
description: Find, read, and follow the skills an organization shares in OpenWork, and save or update OpenWork skills. Use when the user names an OpenWork skill, asks how their team does a task, or asks to save steps as a skill.
---

# Team skills

OpenWork skills are step-by-step procedures that an organization writes once
and shares with its members. The OpenWork tools return only the skills
available to the signed-in account.

## Use a skill

1. Call `list_skills`. Pass `query` only to narrow a long list.
2. Pick the skill that matches the request. If several could match, ask the
   user which one to use. If none matches, say so; do not invent a skill.
3. Call `get_skill` with the skill's `name`, or with its `capability` when
   several skills share a name. Read the whole returned SKILL.md before acting.
4. Follow the skill for the current task. The user's explicit instructions take
   priority over the skill. If the skill needs a tool, file, or connection that
   is not available in this conversation, tell the user what is missing instead
   of improvising that step.

## Save a skill

1. Confirm the skill's name, when it should be used, and its steps with the
   user before saving.
2. Call `create_skill` with a complete SKILL.md: YAML frontmatter with `name`
   (lowercase words joined by hyphens) and `description`, followed by the
   instructions. Pass the readable title as `pluginName`.
3. Report that the skill was saved as a private skill. Saving does not share it
   with the team; sharing happens in OpenWork.

## Update a skill

1. Call `get_skill` to read the current SKILL.md.
2. Show the user the change and confirm it before saving.
3. Call `update_skill` with `skillId` and the complete replacement SKILL.md.
   `skillId` is the last segment of the skill's capability
   (`plugin:<pluginId>:<skillId>`). Built-in skills, whose capability starts
   with `skill:`, cannot be updated.
4. Each update publishes a new version and keeps earlier ones. If OpenWork
   reports that the skill cannot be edited, relay that message.

Never claim that a skill was saved or updated unless the tool result confirms
it.
