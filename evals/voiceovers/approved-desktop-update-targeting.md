# approved-desktop-update-targeting — Automatic update checks select the highest organization-approved published release

Riley uses an organization-managed Windows desktop where administrators approve which Micx releases members can install.

1. Riley is running Micx 0.17.0. Den shows the actual published versions 0.17.0, 0.17.1, and 0.17.2; her administrator approves 0.17.1, while 0.17.2 remains unapproved and disabled until the server allows it.

2. Riley enables automatic checks. Micx first sees the normal stable latest release, then reads Den's published release inventory after her organization's policy blocks that latest version.

3. Micx performs an exact-target check for the highest approved published version newer than Riley's installation. It offers 0.17.1—not the unapproved latest release, 0.17.2.
