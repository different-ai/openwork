$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path ([IO.Path]::GetTempPath()) ('exp-sign-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$certificate = $null
$previousManifest = $env:WINDOWS_PRESERVED_SIGNATURES
$previousCertificate = $env:WINDOWS_TEST_CERTIFICATE_SHA1
$previousSigning = $env:SIGN_WINDOWS
$previousModulePath = $env:PSModulePath
$previousMockCertificate = $env:EXP_SIGN_MOCK_CERTIFICATE
$previousMockRecord = $env:EXP_SIGN_MOCK_RECORD
$script = Join-Path $PSScriptRoot 'windows-signatures.ps1'
function Invoke-TestScript([string[]]$Arguments) {
    & pwsh -NoProfile -NonInteractive -File $script @Arguments
    return $LASTEXITCODE
}
try {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=exp-sign-test' -CertStoreLocation Cert:\CurrentUser\My
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    $store.Open('ReadWrite'); $store.Add($certificate); $store.Close()
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $certificate.Thumbprint
    $env:WINDOWS_PRESERVED_SIGNATURES = Join-Path $root 'preserved.jsonl'
    $payload = Join-Path $root 'payload'
    New-Item -ItemType Directory -Path $payload | Out-Null
    $native = Join-Path $payload 'native.node'
    Add-Type -TypeDefinition 'public class SigningFixture { public static int Value() { return 42; } }' -OutputAssembly $native -OutputType Library
    $unsignedBytes = [IO.File]::ReadAllBytes($native)
    $env:SIGN_WINDOWS = 'true'
    $hook = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../apps/desktop/scripts/windows-sign.cjs'))
    & node -e 'require(process.argv[1])({path:process.argv[2]})' $hook $native
    if ($LASTEXITCODE -ne 0) { throw 'The actual builder hook did not sign the unsigned PE' }
    if ((Get-AuthenticodeSignature -LiteralPath $native).SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Wrong test signer' }
    # Exercise the production module-call branch without contacting Azure.
    # Its switch parameter contract must not turn `$false into FilesFolder='False'.
    $moduleRoot = Join-Path $root 'modules'
    $module = Join-Path $moduleRoot 'ArtifactSigning/0.1.8'
    New-Item -ItemType Directory -Path $module -Force | Out-Null
    $mock = @'
function Invoke-ArtifactSigning {
    [CmdletBinding()]
    param([string]$Endpoint, [string]$CodeSigningAccountName, [string]$CertificateProfileName,
        [string]$Files, [string]$FileDigest, [string]$TimestampRfc3161, [string]$TimestampDigest,
        [switch]$ExcludeAzureCliCredential, [string]$FilesFolder)
    if ($PSBoundParameters.ContainsKey('FilesFolder')) { throw 'Unexpected positional FilesFolder binding' }
    @{ cliExcluded = [bool]$ExcludeAzureCliCredential; digest = $FileDigest; filesFolderBound = $false } |
        ConvertTo-Json | Set-Content -LiteralPath $env:EXP_SIGN_MOCK_RECORD
    $cert = Get-Item "Cert:\CurrentUser\My\$($env:EXP_SIGN_MOCK_CERTIFICATE)"
    Set-AuthenticodeSignature -LiteralPath $Files -Certificate $cert -HashAlgorithm SHA256 | Out-Null
}
'@
    Set-Content -LiteralPath (Join-Path $module 'ArtifactSigning.psm1') -Value $mock
    New-ModuleManifest -Path (Join-Path $module 'ArtifactSigning.psd1') -RootModule ArtifactSigning.psm1 -ModuleVersion 0.1.8 -FunctionsToExport Invoke-ArtifactSigning
    $env:PSModulePath = $moduleRoot + [IO.Path]::PathSeparator + $previousModulePath
    $env:EXP_SIGN_MOCK_CERTIFICATE = $certificate.Thumbprint
    $env:EXP_SIGN_MOCK_RECORD = Join-Path $root 'azure-contract.json'
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $null
    $azureNative = Join-Path $payload 'azure.node'
    [IO.File]::WriteAllBytes($azureNative, $unsignedBytes)
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $azureNative) 2>&1)
    if ($output[-1] -ne 0) { throw 'Production ArtifactSigning parameter contract failed' }
    $contract = Get-Content $env:EXP_SIGN_MOCK_RECORD -Raw | ConvertFrom-Json
    if ($contract.cliExcluded -or $contract.filesFolderBound -or $contract.digest -ne 'SHA256') { throw 'Wrong ArtifactSigning parameters' }
    $env:PSModulePath = $previousModulePath
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $certificate.Thumbprint
    $installer = Join-Path $root 'installer.exe'
    Copy-Item $native $installer
    $thirdParty = Join-Path $payload 'cmd.exe'
    Copy-Item "$env:SystemRoot\System32\cmd.exe" $thirdParty
    $before = (Get-FileHash $thirdParty).Hash
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $thirdParty))
    if ($output[-1] -ne 0 -or (Get-FileHash $thirdParty).Hash -ne $before) { throw 'Valid third-party binary changed' }
    # Windows can select a catalog certificate on one host and the embedded
    # certificate on another for the very same file. The byte hash is stable.
    $preservation = Get-Content $env:WINDOWS_PRESERVED_SIGNATURES | ConvertFrom-Json
    $preservation.subject = 'CN=Alternate validation-host catalog certificate'
    $preservation.thumbprint = '00'
    $preservation | ConvertTo-Json -Compress | Set-Content $env:WINDOWS_PRESERVED_SIGNATURES
    [IO.File]::WriteAllBytes((Join-Path $payload 'linux.node'), [byte[]]@(0x7f, 0x45, 0x4c, 0x46))
    [IO.File]::WriteAllBytes((Join-Path $payload 'darwin.node'), [byte[]]@(0xcf, 0xfa, 0xed, 0xfe))
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer, '-Report', (Join-Path $root 'valid.json')))
    if ($output[-1] -ne 0) { throw 'Valid payload rejected' }
    $rows = @(Get-Content (Join-Path $root 'valid.json') -Raw | ConvertFrom-Json)
    if ($rows.Count -ne 3 -or @($rows | Where-Object { -not $_.accepted }).Count) { throw 'Incomplete PE verification' }
    if (-not ($rows | Where-Object file -eq 'cmd.exe').preserved) { throw 'Third-party preservation was not verified' }
    $corrupt = Join-Path $payload 'corrupt.node'
    [IO.File]::WriteAllText($corrupt, 'invalid native module')
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Unrecognized native module silently ignored' }
    Remove-Item $corrupt
    $fakeExe = Join-Path $payload 'versions.json.exe'
    [IO.File]::WriteAllText($fakeExe, '{}')
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Non-PE .exe silently ignored' }
    Remove-Item $fakeExe
    Remove-Item $env:WINDOWS_PRESERVED_SIGNATURES
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Unexpected publisher accepted without preservation evidence' }
    $bytes = [IO.File]::ReadAllBytes($native); $bytes[40] = $bytes[40] -bxor 1; [IO.File]::WriteAllBytes($native, $bytes)
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $native) 2>&1)
    if ($output[-1] -eq 0) { throw 'Tampered signature replaced' }
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Tampered payload accepted' }
    Remove-Item $native, $azureNative, $thirdParty
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Empty payload accepted' }
    Write-Host 'Passed: builder hook PE signing, ArtifactSigning parameter contract, valid third-party byte preservation, publisher provenance, tamper rejection, empty-payload rejection'
} finally {
    $env:WINDOWS_PRESERVED_SIGNATURES = $previousManifest
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $previousCertificate
    $env:SIGN_WINDOWS = $previousSigning
    $env:PSModulePath = $previousModulePath
    $env:EXP_SIGN_MOCK_CERTIFICATE = $previousMockCertificate
    $env:EXP_SIGN_MOCK_RECORD = $previousMockRecord
    if ($certificate) {
        Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item "Cert:\LocalMachine\Root\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    }
    Remove-Item $root -Recurse -Force
}
# GitHub's pwsh wrapper forwards LASTEXITCODE; expected negative child tests
# must not leave their exit=1 as the successful test suite's final status.
exit 0
