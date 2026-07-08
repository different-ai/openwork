# Enterprise network doctor

`scripts/support/openwork-doctor.ps1` is a Windows PowerShell 5.1-compatible, no-admin, read-only report for customer IT. It checks DNS, TCP 443, the live TLS certificate/chain with `SslStream`, served certificates with `openssl` when available, WinHTTP/.NET proxy settings, PowerShell/OS version, and `NODE_EXTRA_CA_CERTS`. Send this Teams-ready one-liner to the customer's IT contact once the file is available at the raw URL:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "`$p=Join-Path `$env:TEMP 'openwork-doctor.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/different-ai/openwork/dev/scripts/support/openwork-doctor.ps1' -OutFile `$p; & `$p -WebUrl 'https://openwork.example.com' -ApiUrl 'https://api.openwork.example.com' -ExpectedIssuerMatch 'DigiCert'"
```

If raw download is blocked, save `scripts/support/openwork-doctor.ps1` locally and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\openwork-doctor.ps1 -WebUrl 'https://openwork.example.com' -ApiUrl 'https://api.openwork.example.com' -ExpectedIssuerMatch 'DigiCert'
```

Common outcome patterns:

- `LIKELY TLS INTERCEPTION`: the leaf issuer is an internal/proxy CA instead of DigiCert. The corporate proxy is re-signing TLS; allowlist OpenWork hosts or ensure the app runtime trusts that enterprise root.
- `LIKELY MISSING INTERMEDIATE OR UNTRUSTED ROOT` plus `MISSING INTERMEDIATE CONFIRMED BY OPENSSL`: the server is probably serving the DigiCert leaf without the intermediate, or the machine lacks the issuing root. Fix the control-plane TLS `fullchain`/certificate bundle first.
- `LIKELY DNS ISSUE`: the hostname does not resolve on that machine. Check VPN, split-horizon DNS, and whether both web and API hostnames exist internally.
- `PROXY DETECTED`: WinHTTP or .NET routes the URL through a proxy. Verify proxy auth/allowlisting and whether the desktop runtime is expected to use system proxy settings.

`scripts/support/setup-openwork-tls-repro.ps1` is an admin-only Windows VM repro harness. It creates a root/intermediate/leaf chain with `New-SelfSignedCertificate`, trusts only the root, maps `poc.openwork.test` to localhost, and serves two HTTPS endpoints with HTTP.sys/`HttpListener`: healthy `:8443` has an installed intermediate; broken `:9443` uses a leaf whose intermediate was removed. Run in a Daytona Windows-class sandbox from an elevated PowerShell prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\support\setup-openwork-tls-repro.ps1
```

Then point an old desktop build at the broken URL to baseline the generic `fetch failed`, and a new build at both URLs to verify healthy success plus a named TLS/chain error for broken. Capture `curl.exe`, `node -e fetch(...)`, and doctor output from the printed test matrix. Clean up with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\support\setup-openwork-tls-repro.ps1 -Cleanup
```
