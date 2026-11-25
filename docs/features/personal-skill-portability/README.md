# Personal skill portability

Generally available; `personalSkillPortability` was retired in November 2026 · Cloud and self-hosted · owner: `benjaminshafii`.

In **My Library → Move private skills**, members download a JSON file of their own unshared skills or import one into their current workspace. Imports create private copies, never replace existing skills, and never carry sharing grants. The file contains skill text; treat it as confidential. Credentials, automations, and activity history are not part of this format.

**Settings → Config → Export** downloads shared configuration only. It is not a full backup. Members can move private skills separately without first sharing them. The organization export never reads private skill content.

To try it, create one private skill in a test organization, then download it in My Library. In a second test organization, choose that file and confirm the import. Check that the skill is now in My Library and remains private.

The export and import routes still require a signed-in member of the workspace with a recent sign-in; API keys and MCP tokens are refused. Stored overrides and operator locks for the retired key are ignored.
