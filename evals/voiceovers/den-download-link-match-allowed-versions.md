# den-download-link-match-allowed-versions — Enterprise downloads use the highest allowed desktop version

The organization-wide desktop version policy applies to every member who downloads the enterprise app from Den.

1. An admin allows desktop versions 0.17.37 and 0.17.38, while 0.17.39 remains disallowed.

2. A non-admin signs in to the single-organization dashboard and opens the direct enterprise download page.

3. Clicking “Download OpenWork Enterprise” downloads OpenWork Enterprise 0.17.38—the highest version permitted by the organization.

4. If an admin pins legacy versions 0.17.26 and 0.17.27, Den downloads v0.17.27—the exact version the organization allows—rather than overriding the pin.

5. Organizations without version restrictions follow Den’s configured GitHub release while keeping the Den install token out of the download URL.
