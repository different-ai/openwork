# deterministic-org-installer — deterministic organization setup with the standard app

1. From my organization’s download page, I choose my platform and receive one organization setup ZIP built around the standard OpenWork application—not a separately compiled organization-specific app.

2. After extracting it, I see the generic signed OpenWork Installer, the standard signed DMG or EXE, and one organization JSON configuration file containing the server addresses, application name, wordmark and square icon.

3. I launch this specific installer and it shows the organization name and exact server address before making changes. I confirm the destination, so an old testing download cannot silently configure my app.

4. With public internet access disabled, the installer uses the standard application artifact already inside the ZIP, writes the configuration to OpenWork’s canonical location, and completes installation without GitHub access.

5. On the first macOS launch from Applications, OpenWork immediately targets the correct on-prem server and displays the organization name, sign-in branding and Dock icon—without searching Downloads or Desktop.

6. On Windows, the first launch and installed shortcut use the organization name and square icon in the Start menu and taskbar while the underlying OpenWork executable remains the standard signed application.

7. I leave a second testing bundle in Downloads and restart OpenWork. Nothing changes because configuration is only applied by explicitly launching and confirming that bundle’s installer.

8. After upgrading the standard OpenWork application, the same server configuration and branding remain active.
