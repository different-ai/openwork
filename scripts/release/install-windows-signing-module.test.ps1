$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-windows-signing-module.ps1')

function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Get-PSRepository { param($Name, $ErrorAction) if ($script:registered) { return @{ SourceLocation = $script:source } } }
function Register-PSRepository { param([switch]$Default, $ErrorAction) Assert $Default 'Must register defaults only'; $script:registered = $true; $script:registrations++ }
function Install-Module {
    param($Name, $RequiredVersion, [switch]$Force, $Repository, $ErrorAction)
    Assert ($Name -eq 'ArtifactSigning' -and $RequiredVersion -eq '0.1.8' -and $Repository -eq 'PSGallery') 'Pinned official module must be preserved'
    $script:attempts++
    if ($script:attempts -le $script:failures) { throw $script:failureMessage }
}
function Start-Sleep { param($Seconds) $script:waits += $Seconds }
function Reset-Case {
    $script:registered = $false
    $script:source = 'https://www.powershellgallery.com/api/v2'
    $script:registrations = 0
    $script:attempts = 0
    $script:failures = 0
    $script:failureMessage = 'HTTP 503 Service Unavailable'
    $script:waits = @()
}

Reset-Case
Install-WindowsSigningModule
Assert ($script:registrations -eq 1 -and $script:attempts -eq 1) 'Missing gallery must be registered before install'
Reset-Case
$script:registered = $true
$script:failures = 1
Install-WindowsSigningModule
Assert ($script:registrations -eq 0 -and $script:attempts -eq 2 -and $script:waits.Count -eq 1) 'Transport failure must retry'
Reset-Case
$script:failures = 10
$threw = $false
try { Install-WindowsSigningModule } catch { $threw = $true }
Assert ($threw -and $script:attempts -eq 3) 'Persistent transport failure must fail after three attempts'
foreach ($message in @('Forbidden', 'signature validation failed HTTP 503', 'Module not found')) {
    Reset-Case
    $script:failures = 10
    $script:failureMessage = $message
    $threw = $false
    try { Install-WindowsSigningModule } catch { $threw = $true }
    Assert ($threw -and $script:attempts -eq 1) 'Deterministic/security failure must not retry'
}
Reset-Case
$script:registered = $true
$script:source = 'https://untrusted.invalid/api/v2'
$threw = $false
try { Install-WindowsSigningModule } catch { $threw = $true }
Assert ($threw -and $script:attempts -eq 0) 'Never install from a substituted gallery'
Write-Host 'Signing module setup: 7 cases passed'
