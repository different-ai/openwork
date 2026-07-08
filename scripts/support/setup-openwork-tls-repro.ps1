param(
    [string]$Hostname = "poc.openwork.test",
    [int]$HealthyPort = 8443,
    [int]$BrokenPort = 9443,
    [switch]$Cleanup
)

$ErrorActionPreference = "Stop"
$Marker = "OpenWork TLS Repro"
$ReproDir = Join-Path (Get-Location).Path "tls-repro"
$StatePath = Join-Path $ReproDir "state.txt"
$HostsMarker = "# OpenWork TLS repro"
$SslAppId = "{1f6c8f8b-6b57-4a0b-8a1c-8d7e3d8f0d31}"

function Write-Step {
    param([string]$Message = "")
    Write-Host $Message
}

function Assert-WindowsAdmin {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        Write-Step "ERROR: This setup script is Windows-only because it uses New-SelfSignedCertificate, Cert:\LocalMachine, netsh, and HttpListener TLS bindings."
        exit 1
    }

    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList $identity
        $isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            Write-Step "ERROR: Run this from an elevated PowerShell prompt (Run as Administrator)."
            exit 1
        }
    }
    catch {
        Write-Step "ERROR: Could not verify administrator privileges. Run this from elevated Windows PowerShell."
        Write-Step $_.Exception.Message
        exit 1
    }
}

function Read-State {
    $state = @{}
    if (Test-Path -LiteralPath $StatePath) {
        foreach ($line in (Get-Content -LiteralPath $StatePath)) {
            if ($line -match "^([^=]+)=(.*)$") {
                $state[$matches[1]] = $matches[2]
            }
        }
    }
    return $state
}

function Remove-SslBinding {
    param([int]$Port)

    try {
        $ipPort = "0.0.0.0:{0}" -f $Port
        $output = & netsh http delete sslcert ipport=$ipPort 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Step ("Removed SSL binding {0}." -f $ipPort)
        }
        else {
            Write-Step ("No removable SSL binding at {0} (netsh: {1})." -f $ipPort, (($output | Out-String).Trim()))
        }
    }
    catch {
        Write-Step ("WARN: Could not remove SSL binding for port {0}: {1}" -f $Port, $_.Exception.Message)
    }
}

function Add-SslBinding {
    param(
        [int]$Port,
        [string]$Thumbprint
    )

    Remove-SslBinding -Port $Port
    $ipPort = "0.0.0.0:{0}" -f $Port
    $output = & netsh http add sslcert ipport=$ipPort certhash=$Thumbprint appid=$SslAppId certstorename=MY 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("netsh http add sslcert failed for {0}: {1}" -f $ipPort, (($output | Out-String).Trim()))
    }
    Write-Step ("Added SSL binding {0} -> {1}." -f $ipPort, $Thumbprint)
}

function Stop-ReproJobs {
    try {
        $jobs = Get-Job -Name "OpenWorkTlsRepro-*" -ErrorAction SilentlyContinue
        foreach ($job in $jobs) {
            Write-Step ("Stopping PowerShell job {0} (Id {1})." -f $job.Name, $job.Id)
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
    catch {
        Write-Step ("WARN: Could not stop repro jobs in this session: {0}" -f $_.Exception.Message)
    }
}

function Remove-HostsEntries {
    param([string[]]$Names)

    $hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
    if (-not (Test-Path -LiteralPath $hostsPath)) {
        Write-Step ("WARN: Hosts file not found at {0}." -f $hostsPath)
        return
    }

    $lines = Get-Content -LiteralPath $hostsPath
    $newLines = @()
    $changed = $false
    foreach ($line in $lines) {
        $removeLine = $false
        if ($line -match [regex]::Escape($HostsMarker)) {
            $removeLine = $true
        }
        else {
            foreach ($name in $Names) {
                if (-not [string]::IsNullOrWhiteSpace($name)) {
                    $escapedName = [regex]::Escape($name)
                    if ($line -match ("^\s*127\.0\.0\.1\s+{0}(\s|$)" -f $escapedName)) {
                        $removeLine = $true
                    }
                }
            }
        }

        if ($removeLine) {
            $changed = $true
        }
        else {
            $newLines += $line
        }
    }

    if ($changed) {
        Set-Content -LiteralPath $hostsPath -Value $newLines -Encoding ASCII
        Write-Step "Removed repro hosts-file entries."
    }
    else {
        Write-Step "No repro hosts-file entries found."
    }
}

function Add-HostsEntry {
    param([string]$Name)

    $hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
    $escapedName = [regex]::Escape($Name)
    $existingLines = @()
    if (Test-Path -LiteralPath $hostsPath) {
        $existingLines = Get-Content -LiteralPath $hostsPath
    }

    foreach ($line in $existingLines) {
        if ($line -match ("^\s*127\.0\.0\.1\s+{0}(\s|$)" -f $escapedName)) {
            Write-Step ("Hosts file already maps 127.0.0.1 to {0}." -f $Name)
            return
        }
        if ($line -match ("^\s*\S+\s+{0}(\s|$)" -f $escapedName)) {
            Write-Step ("WARN: Hosts file already mentions {0}: {1}" -f $Name, $line)
        }
    }

    Add-Content -LiteralPath $hostsPath -Value ("127.0.0.1 {0} {1}" -f $Name, $HostsMarker) -Encoding ASCII
    Write-Step ("Added hosts-file entry: 127.0.0.1 {0}." -f $Name)
}

function Remove-CertificatesByThumbprint {
    param([string[]]$Thumbprints)

    $stores = @("Cert:\LocalMachine\My", "Cert:\LocalMachine\Root", "Cert:\LocalMachine\CA", "Cert:\CurrentUser\My")
    foreach ($thumbprint in ($Thumbprints | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        foreach ($store in $stores) {
            try {
                $matches = Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumbprint }
                foreach ($cert in $matches) {
                    Write-Step ("Removing certificate thumbprint {0} from {1}." -f $thumbprint, $store)
                    Remove-Item -LiteralPath $cert.PSPath -Force -ErrorAction SilentlyContinue
                }
            }
            catch {
                Write-Step ("WARN: Could not scan {0}: {1}" -f $store, $_.Exception.Message)
            }
        }
    }
}

function Remove-CertificatesByMarker {
    $stores = @("Cert:\LocalMachine\My", "Cert:\LocalMachine\Root", "Cert:\LocalMachine\CA", "Cert:\CurrentUser\My")
    foreach ($store in $stores) {
        try {
            $matches = Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like ("*{0}*" -f $Marker) }
            foreach ($cert in $matches) {
                Write-Step ("Removing marked certificate {0} from {1}." -f $cert.Thumbprint, $store)
                Remove-Item -LiteralPath $cert.PSPath -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-Step ("WARN: Could not remove marked certs from {0}: {1}" -f $store, $_.Exception.Message)
        }
    }
}

function Invoke-Cleanup {
    param([switch]$Quiet)

    if (-not $Quiet) {
        Write-Step "Cleaning OpenWork TLS repro artifacts..."
    }

    $state = Read-State
    $ports = @($HealthyPort, $BrokenPort)
    if ($state.ContainsKey("HealthyPort")) { $ports += [int]$state["HealthyPort"] }
    if ($state.ContainsKey("BrokenPort")) { $ports += [int]$state["BrokenPort"] }
    foreach ($port in ($ports | Select-Object -Unique)) {
        Remove-SslBinding -Port $port
    }

    Stop-ReproJobs

    $names = @($Hostname)
    if ($state.ContainsKey("Hostname")) { $names += $state["Hostname"] }
    Remove-HostsEntries -Names ($names | Select-Object -Unique)

    $thumbprints = @()
    foreach ($key in $state.Keys) {
        if ($key -match "Thumbprint$") {
            $thumbprints += $state[$key]
        }
    }
    Remove-CertificatesByThumbprint -Thumbprints $thumbprints
    Remove-CertificatesByMarker

    if (Test-Path -LiteralPath $ReproDir) {
        Remove-Item -LiteralPath $ReproDir -Recurse -Force
        Write-Step ("Removed {0}." -f $ReproDir)
    }
}

function Start-ReproListenerJob {
    param(
        [int]$Port,
        [string]$Label
    )

    $jobName = "OpenWorkTlsRepro-{0}" -f $Port
    $existing = Get-Job -Name $jobName -ErrorAction SilentlyContinue
    foreach ($job in $existing) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    # Windows-only runtime path. This section is parse-checked from macOS but must be exercised in a Daytona Windows sandbox.
    # HttpListener delegates TLS to HTTP.sys/Schannel. The healthy port can send the intermediate because it is installed
    # in LocalMachine\CA; the broken port binds a leaf whose intermediate is intentionally removed from local stores.
    $job = Start-Job -Name $jobName -ArgumentList $Port, $Label -ScriptBlock {
        param([int]$Port, [string]$Label)

        $ErrorActionPreference = "Stop"
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add(("https://+:{0}/" -f $Port))
        $listener.Start()
        try {
            while ($true) {
                $context = $listener.GetContext()
                $payload = '{"workspaces":[]}'
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
                $context.Response.StatusCode = 200
                $context.Response.ContentType = "application/json"
                $context.Response.Headers.Add("X-OpenWork-TLS-Repro", $Label)
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.OutputStream.Close()
            }
        }
        finally {
            $listener.Stop()
            $listener.Close()
        }
    }

    Start-Sleep -Milliseconds 1000
    $job = Get-Job -Id $job.Id
    if ($job.State -ne "Running") {
        $details = Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue | Out-String
        throw ("Listener job {0} did not stay running. State={1}. Output={2}" -f $jobName, $job.State, $details)
    }

    Write-Step ("Started HTTPS listener job {0} (Id {1})." -f $job.Name, $job.Id)
}

Assert-WindowsAdmin

if ($Cleanup) {
    Invoke-Cleanup
    exit 0
}

Write-Step "OpenWork TLS repro setup"
Write-Step "Strategy: HTTP.sys/HttpListener with netsh sslcert bindings. Healthy uses root + installed intermediate; broken uses a different intermediate that is removed before serving."
Write-Step "Risk: Windows chain caching can occasionally make the broken case validate until cache/session state is cleared; rerun -Cleanup or use a fresh VM if that happens."
Write-Step ""

Invoke-Cleanup -Quiet
New-Item -ItemType Directory -Path $ReproDir -Force | Out-Null

$notAfter = (Get-Date).AddYears(1)
$rootSubject = "CN=OpenWork TLS Repro Root CA, O=$Marker"
$healthyIntermediateSubject = "CN=OpenWork TLS Repro Healthy Intermediate CA, O=$Marker"
$brokenIntermediateSubject = "CN=OpenWork TLS Repro Broken Intermediate CA, O=$Marker"
$healthyLeafSubject = "CN=$Hostname, O=$Marker"
$brokenLeafSubject = "CN=$Hostname, O=$Marker"
$leafExtensions = @(
    "2.5.29.17={text}DNS=$Hostname",
    "2.5.29.19={critical}{text}ca=0",
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
)

Write-Step "Generating root, intermediates, and leaf certificates with New-SelfSignedCertificate..."
$root = New-SelfSignedCertificate -Type Custom -Subject $rootSubject -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign, DigitalSignature -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=2") -CertStoreLocation "Cert:\LocalMachine\My" -NotAfter $notAfter
$healthyIntermediate = New-SelfSignedCertificate -Type Custom -Subject $healthyIntermediateSubject -Signer $root -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign, DigitalSignature -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=0") -CertStoreLocation "Cert:\LocalMachine\My" -NotAfter $notAfter
$brokenIntermediate = New-SelfSignedCertificate -Type Custom -Subject $brokenIntermediateSubject -Signer $root -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign, DigitalSignature -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=0") -CertStoreLocation "Cert:\LocalMachine\My" -NotAfter $notAfter
$healthyLeaf = New-SelfSignedCertificate -Type Custom -Subject $healthyLeafSubject -Signer $healthyIntermediate -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeySpec KeyExchange -KeyUsage DigitalSignature, KeyEncipherment -TextExtension $leafExtensions -CertStoreLocation "Cert:\LocalMachine\My" -NotAfter $notAfter
$brokenLeaf = New-SelfSignedCertificate -Type Custom -Subject $brokenLeafSubject -Signer $brokenIntermediate -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeySpec KeyExchange -KeyUsage DigitalSignature, KeyEncipherment -TextExtension $leafExtensions -CertStoreLocation "Cert:\LocalMachine\My" -NotAfter $notAfter

$rootPath = Join-Path $ReproDir "root.cer"
$healthyIntermediatePath = Join-Path $ReproDir "healthy-intermediate.cer"
Export-Certificate -Cert $root -FilePath $rootPath | Out-Null
Export-Certificate -Cert $healthyIntermediate -FilePath $healthyIntermediatePath | Out-Null
Import-Certificate -FilePath $rootPath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
Import-Certificate -FilePath $healthyIntermediatePath -CertStoreLocation "Cert:\LocalMachine\CA" | Out-Null
Write-Step ("Installed ONLY the repro root into Cert:\LocalMachine\Root: {0}" -f $root.Thumbprint)
Write-Step ("Installed healthy intermediate into Cert:\LocalMachine\CA so Schannel can build/send that chain: {0}" -f $healthyIntermediate.Thumbprint)

# The broken leaf was signed by this intermediate, then the intermediate is removed from local stores.
# If a Windows build caches it anyway, the broken endpoint may validate until cache/session state is reset.
Remove-CertificatesByThumbprint -Thumbprints @($brokenIntermediate.Thumbprint)
Write-Step ("Removed broken intermediate from local stores: {0}" -f $brokenIntermediate.Thumbprint)

$stateLines = @(
    "Hostname=$Hostname",
    "HealthyPort=$HealthyPort",
    "BrokenPort=$BrokenPort",
    "RootThumbprint=$($root.Thumbprint)",
    "HealthyIntermediateThumbprint=$($healthyIntermediate.Thumbprint)",
    "BrokenIntermediateThumbprint=$($brokenIntermediate.Thumbprint)",
    "HealthyLeafThumbprint=$($healthyLeaf.Thumbprint)",
    "BrokenLeafThumbprint=$($brokenLeaf.Thumbprint)"
)
Set-Content -LiteralPath $StatePath -Value $stateLines -Encoding ASCII

Add-HostsEntry -Name $Hostname
Add-SslBinding -Port $HealthyPort -Thumbprint $healthyLeaf.Thumbprint
Add-SslBinding -Port $BrokenPort -Thumbprint $brokenLeaf.Thumbprint
Start-ReproListenerJob -Port $HealthyPort -Label "healthy-chain"
Start-ReproListenerJob -Port $BrokenPort -Label "broken-missing-intermediate"

$healthyUrl = "https://{0}:{1}/" -f $Hostname, $HealthyPort
$brokenUrl = "https://{0}:{1}/" -f $Hostname, $BrokenPort
$rootPathForNode = (Resolve-Path -LiteralPath $rootPath).Path

Write-Step ""
Write-Step "Setup complete. Keep this PowerShell window open so the background jobs keep serving."
Write-Step ""
Write-Step "Test matrix (paste each result under the command that produced it):"
Write-Step ("1. curl healthy (expect HTTP 200 with {0}):" -f '{"workspaces":[]}')
Write-Step ("   curl.exe -v {0}" -f $healthyUrl)
Write-Step "2. curl broken (expect certificate/chain failure on a fresh VM; if it succeeds, Windows found a cached intermediate):"
Write-Step ("   curl.exe -v {0}" -f $brokenUrl)
Write-Step "3. Doctor against both local endpoints:"
Write-Step ("   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\support\openwork-doctor.ps1 -WebUrl {0} -ApiUrl {1} -ExpectedIssuerMatch `"OpenWork TLS Repro`"" -f $healthyUrl, $brokenUrl)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand -ne $null) {
    $nodeHealthy = "node -e `"fetch('$healthyUrl').then(r=>r.text()).then(console.log).catch(e=>{ console.error(e); process.exit(1) })`""
    $nodeBroken = "node -e `"fetch('$brokenUrl').then(r=>r.text()).then(console.log).catch(e=>{ console.error(e); process.exit(1) })`""
    Write-Step "4. Node fetch without extra CA (often fails because stock Node may not use Windows LocalMachine Root):"
    Write-Step ("   {0}" -f $nodeHealthy)
    Write-Step ("   {0}" -f $nodeBroken)
    Write-Step "5. Node fetch with the repro root trusted through NODE_EXTRA_CA_CERTS (healthy should OK; broken should fail):"
    Write-Step ("   `$env:NODE_EXTRA_CA_CERTS = `"{0}`"" -f $rootPathForNode)
    Write-Step ("   {0}" -f $nodeHealthy)
    Write-Step ("   {0}" -f $nodeBroken)
}
else {
    Write-Step "4. Node fetch: node.exe was not found on PATH. Install Node or skip this part."
    Write-Step "   Expected when Node is available: healthy OK only with NODE_EXTRA_CA_CERTS/system CA integration; broken FAIL."
}

Write-Step ""
Write-Step "Cleanup when finished:"
Write-Step "   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\support\setup-openwork-tls-repro.ps1 -Cleanup"
