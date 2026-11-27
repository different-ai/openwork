# Supporting files in GitHub-connected skills

- Feature key: `githubConnectorSkillFiles`
- Deployments: Cloud and self-hosted, off by default
- Owner: `MaxBer`

Enable this for an organization and sync a connected repository containing a skill with a nested Markdown reference. Open the skill and verify that its reference can be read. Edit only the reference and sync again; the same skill should show the new content. Deleting the reference should remove it on the next sync.

The connector uses the existing GitHub App installation and imports text files subject to the same size and path limits as the public URL importer. No new GitHub permissions are required.

Turning the flag off stops syncing supporting files. Already imported files remain available, including when the entrypoint is updated while the flag is off. Watch GitHub connector sync failures and GitHub API rate limits when enabling the feature for large repositories. An incomplete GitHub tree or a failed supporting-file fetch does not replace a skill's last good version.
