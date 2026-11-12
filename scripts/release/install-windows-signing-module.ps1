$ErrorActionPreference = 'Stop'

function Install-WindowsSigningModule {
    # Hosted images do not always register the built-in gallery. Restore only
    # the official default; never install a signing module from an arbitrary URL.
    $gallery = Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue
    if (-not $gallery) {
        Register-PSRepository -Default -ErrorAction Stop
        $gallery = Get-PSRepository -Name PSGallery -ErrorAction Stop
    }
    if ($gallery.SourceLocation.TrimEnd('/') -ne 'https://www.powershellgallery.com/api/v2') {
        throw 'PSGallery does not point to the official PowerShell Gallery'
    }
    # Same version used by azure/artifact-signing-action v2.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Install-Module -Name ArtifactSigning -RequiredVersion 0.1.8 -Force -Repository PSGallery -ErrorAction Stop
            return
        } catch {
            $message = $_.ToString()
            $transient = $message -match '(?i)timed?\s*out|temporar(?:y|ily)|connection (?:reset|closed)|remote name could not be resolved|name resolution|\b(?:429|500|502|503|504)\b'
            $unsafe = $message -match '(?i)certificate|signature|unauthorized|forbidden|access.*denied|hash.*mismatch'
            if ($attempt -eq 3 -or -not $transient -or $unsafe) { throw }
            Write-Warning "PowerShell Gallery transport failed; retrying pinned module install ($attempt/3)."
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Install-WindowsSigningModule }
