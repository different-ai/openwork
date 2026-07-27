# update-install-self-heal — Stale update installs recover instead of dead-ending

Riley keeps OpenWork current from the stable desktop channel.

1. Riley is on OpenWork 0.17.0, and 0.17.1 is available on the stable channel. She checks for updates, downloads it, and the Updates page shows 0.17.1 is ready to install.

2. Her staged download has gone stale before restart. In the old flow, Install & restart left her at a scary "Couldn't check for updates" dead end; now OpenWork quietly checks again and returns her to a working Update available screen.

3. Riley downloads 0.17.1 again and chooses Install & restart. This time the install request goes through, with no stale-download error on the page.
