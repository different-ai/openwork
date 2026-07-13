# generic-installer-release-contract — A release link is proven by downloading it

1. A collision-proof prerelease built from the exact pull-request commit exposes its generic Mac installer anonymously, and the downloaded zip contains the signed, notarized app at its root.

2. The exact v0.17.19 ARM64 URL that returned Not Found now downloads real bytes, passes zip integrity, and contains a Gatekeeper-accepted installer.

3. Future stable releases cannot become public until the reusable installer job has uploaded every required generic asset; older releases without one safely redirect only to a verified normal download.
