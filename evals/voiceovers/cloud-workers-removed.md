# cloud-workers-removed — The Cloud Workers tab is gone, and old links land safely

The desktop app is sunsetting the "Cloud Workers" settings tab (the eval spec
already called it a legacy feature being sunset). This demo walks the Cloud
area of Settings after the removal: the sidebar no longer offers Cloud
Workers, the Account tab's copy no longer promises them, and the old
cloud-workers deep link redirects to the Account tab instead of breaking.
Connecting to a hosted workspace still works through the existing
"Connect custom remote" flow — nothing in that path is touched here.

1. This is Settings. On the left, the Cloud group is now just one thing: Account. The Cloud Workers tab that used to sit here is gone — no dead entry, no placeholder, just a shorter list.

2. Opening Account shows the same Cloud sign-in surface as before. The description now simply says to sign in and pick an organization — it no longer promises a Cloud workers list that doesn't exist. Nothing on this page mentions Cloud workers at all.

3. And the old link still works: navigating straight to the retired cloud-workers address quietly lands on this same Account tab. Anyone with an old bookmark or doc gets a working page, not an error.
