# Personal skill portability

`personalSkillPortability` · Cloud and self-hosted · off by default · owner: `benjaminshafii`.

In **My Library → Move private skills**, members download a JSON file of their own unshared skills or import one into their current workspace. Imports create private copies, never replace existing skills, and never carry sharing grants. The file contains skill text; treat it as confidential. Credentials, automations, and activity history are not part of this format.

**Settings → Config → Export** downloads shared configuration only. It is not a full backup. Members can move private skills separately without first sharing them. The organization export never reads private skill content.

To try it, enable the feature for a test organization, create one private skill, then download it in My Library. In a second test organization with the feature on, choose that file and confirm the import. Check that the skill is now in My Library and remains private. Turn the flag off to remove the entry points and disallow the portability routes; imported skills remain in My Library.
