param(
    [Parameter(Mandatory)][ValidateSet('Sign', 'Verify', 'VerifyPackage')][string]$Mode,
    [Parameter(Mandatory)][string]$Path,
    [string]$Installer,
    [string]$Report
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-PE([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { return $false }
        $stream.Position = 60
        $offset = $reader.ReadUInt32()
        if ($offset -gt $stream.Length - 4) { return $false }
        $stream.Position = $offset
        return $reader.ReadUInt32() -eq 0x4550
    } finally { $reader.Dispose() }
}

function Test-NonWindowsNative([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 4) { return $false }
        return $reader.ReadUInt32().ToString('X8') -in @('464C457F', 'CEFAEDFE', 'CFFAEDFE', 'FEEDFACE', 'FEEDFACF', 'BEBAFECA', 'CAFEBABE')
    } finally { $reader.Dispose() }
}

if ($Mode -eq 'Sign') {
    if (-not (Test-PE $Path)) { throw 'Signing requires a PE file' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -eq 'Valid') {
        # Content-addressed provenance also works after NSIS changes the install path.
        # Never re-sign a valid upstream binary, even when builder calls us twice.
        if (-not $env:WINDOWS_PRESERVED_SIGNATURES) { throw 'Missing preservation manifest path' }
        $record = @{
            sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
            subject = $signature.SignerCertificate.Subject
            thumbprint = $signature.SignerCertificate.Thumbprint
        } | ConvertTo-Json -Compress
        [IO.File]::AppendAllText($env:WINDOWS_PRESERVED_SIGNATURES, $record + "`n")
        Write-Host "Preserved valid signature: $([IO.Path]::GetFileName($Path))"
        exit 0
    }
    if ($signature.Status -ne 'NotSigned') { throw "Refusing to replace an invalid signature: $($signature.Status)" }
    if ($env:WINDOWS_TEST_CERTIFICATE_SHA1) {
        # Disposable Windows lab only; production never sets this variable.
        $certificate = Get-Item "Cert:\CurrentUser\My\$($env:WINDOWS_TEST_CERTIFICATE_SHA1)"
        Set-AuthenticodeSignature -LiteralPath $Path -Certificate $certificate -HashAlgorithm SHA256 | Out-Null
    } else {
        Import-Module ArtifactSigning -RequiredVersion 0.1.8
        Invoke-ArtifactSigning -Endpoint $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
            -CodeSigningAccountName $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
            -CertificateProfileName $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE `
            -Files $Path -FileDigest SHA256 -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
            -TimestampDigest SHA256 -ExcludeAzureCliCredential:$false
    }
    $signed = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signed.Status -ne 'Valid') { throw "Signing did not produce a valid signature: $($signed.Status)" }
    exit 0
}

if ($Mode -eq 'VerifyPackage') {
    $installers = @(Get-ChildItem -LiteralPath $Path -Filter '*.exe' -File)
    if ($installers.Count -ne 1) { throw 'Expected exactly one Windows installer' }
    $Installer = $installers[0].FullName
    $packages = @(Get-ChildItem -LiteralPath $Path -Directory -Filter '*unpacked')
    if ($packages.Count -ne 1) { throw 'Expected exactly one unpacked Windows application' }
    $evidence = Join-Path $Path 'signature-evidence'
    New-Item -ItemType Directory -Force -Path $evidence | Out-Null
    & $PSCommandPath -Mode Verify -Path $packages[0].FullName -Installer $Installer -Report (Join-Path $evidence 'packaged.json')
    $uninstaller = Join-Path $evidence 'uninstaller.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Signed generated NSIS uninstaller was not retained' }
    $uninstallerSignature = Get-AuthenticodeSignature -LiteralPath $uninstaller
    $installerSignature = Get-AuthenticodeSignature -LiteralPath $Installer
    if ($uninstallerSignature.Status -ne 'Valid' -or $uninstallerSignature.SignerCertificate.Subject -ne $installerSignature.SignerCertificate.Subject) {
        throw 'Generated NSIS uninstaller has an invalid signature or unexpected publisher'
    }
    if (Test-Path -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES) {
        Copy-Item -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES -Destination (Join-Path $evidence 'preserved.jsonl')
    }
    if ($packages[0].Name -eq 'win-arm64-unpacked' -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'Arm64') {
        Write-Host 'ARM64 installation NotRun on x64 host: all packaged PEs, installer and exact embedded uninstaller verified instead.'
        exit 0
    }
    $installed = Join-Path $env:RUNNER_TEMP 'exp-sign-installed'
    try {
        $process = Start-Process -FilePath $Installer -ArgumentList @('/S', '/currentuser', "/D=$installed") -PassThru
        if (-not $process.WaitForExit(180000)) { $process.Kill(); throw 'Installer timed out' }
        if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
        $uninstallers = @(Get-ChildItem -LiteralPath $installed -Filter 'Uninstall *.exe')
        if ($uninstallers.Count -ne 1) { throw 'Installed NSIS uninstaller is missing' }
        if ((Get-FileHash -LiteralPath $uninstallers[0].FullName).Hash -ne (Get-FileHash -LiteralPath $uninstaller).Hash) {
            throw 'Installed uninstaller differs from the signed generated uninstaller'
        }
        & $PSCommandPath -Mode Verify -Path $installed -Installer $Installer -Report (Join-Path $evidence 'installed.json')
        if (Test-Path -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES) {
            Copy-Item -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES -Destination (Join-Path $evidence 'preserved.jsonl')
        }
    } finally {
        $uninstaller = @(Get-ChildItem -LiteralPath $installed -Filter 'Uninstall *.exe' -ErrorAction SilentlyContinue)
        if ($uninstaller.Count -eq 1) {
            $cleanup = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList @('/S', "_?=$installed") -PassThru
            if (-not $cleanup.WaitForExit(60000)) { $cleanup.Kill(); throw 'Uninstaller timed out' }
        }
        Remove-Item -LiteralPath $installed -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

if (-not $Installer) { throw 'Verification requires the signed installer as publisher reference' }
$reference = Get-AuthenticodeSignature -LiteralPath $Installer
if ($reference.Status -ne 'Valid') { throw "Invalid installer signature: $($reference.Status)" }
$preserved = @()
if ($env:WINDOWS_PRESERVED_SIGNATURES -and (Test-Path -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES)) {
    $preserved = @(Get-Content -LiteralPath $env:WINDOWS_PRESERVED_SIGNATURES | ForEach-Object { $_ | ConvertFrom-Json })
}
$root = (Resolve-Path -LiteralPath $Path).Path
$rows = @(foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
    if (-not (Test-PE $file.FullName)) {
        if ($file.Extension -in @('.exe', '.dll')) { throw "Non-PE file masquerades as executable: $($file.Name)" }
        if ($file.Extension -eq '.node') {
            if (-not (Test-NonWindowsNative $file.FullName)) { throw "Unrecognized native module: $($file.Name)" }
            Write-Host "Non-Windows ELF/Mach-O prebuild (not a PE): $([IO.Path]::GetRelativePath($root, $file.FullName))"
        }
        continue
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $unchanged = $false
    if ($signature.SignerCertificate) {
        # The hash includes every embedded signature byte. Windows may choose
        # a different valid catalog certificate on another verification host;
        # do not confuse that host-local choice with a changed/re-signed file.
        $unchanged = @($preserved | Where-Object { $_.sha256 -eq $hash }).Count -gt 0
    }
    [pscustomobject]@{
        file = [IO.Path]::GetRelativePath($root, $file.FullName)
        status = [string]$signature.Status
        subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
        sha256 = $hash
        preserved = $unchanged
        accepted = $signature.Status -eq 'Valid' -and ($unchanged -or $signature.SignerCertificate.Subject -eq $reference.SignerCertificate.Subject)
    }
})
if ($Report) { ConvertTo-Json -InputObject $rows -Depth 5 | Set-Content -LiteralPath $Report -Encoding utf8 }
$rows | Format-Table file, status, subject, preserved -AutoSize | Out-Host
if ($rows.Count -eq 0) { throw 'No PE files found; refusing an empty verification' }
$failed = @($rows | Where-Object { -not $_.accepted })
if ($failed.Count) { throw "$($failed.Count) PE files have invalid signatures or an unexpected publisher" }
Write-Host "Verified $($rows.Count) PE files; publisher: $($reference.SignerCertificate.Subject)"
