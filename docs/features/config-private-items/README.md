# Private items in Config migrations

`configPrivateItems` is off by default on cloud and self-hosted Den. Rollout owner: `yomgui`.

Enable it in the source organization to include private plugins and server-stored components in **Settings → Config → Export**. Use **Whole organization** for a migration so that People, Skills and Plugins travel together. Enable it in the destination for private-item import behavior and 90-day invitations created by Config. Other invitations still expire after seven days. A late SSO join can claim an expired placeholder only if the organization would already admit the person.

To verify, create a private plugin with a skill and supporting file in a synthetic source organization. Export and review the import in a second test organization. Check that the intended owner receives the skill after joining and that an ordinary peer cannot use it. Turning the flag off restores shared-only exports and the prior invitation behavior. It does not undo applied imports.
