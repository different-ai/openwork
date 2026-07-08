param(
    [string]$WebUrl = "",
    [string]$ApiUrl = "",
    [string]$ExpectedIssuerMatch = "DigiCert"
)

$ErrorActionPreference = "Continue"
$script:VerdictHints = @()

function Write-Report {
    param([string]$Message = "")
    Write-Output $Message
}

function Add-VerdictHint {
    param([string]$Hint)

    if ([string]::IsNullOrWhiteSpace($Hint)) {
        return
    }

    if ($script:VerdictHints -notcontains $Hint) {
        $script:VerdictHints += $Hint
    }
}

function Write-ExceptionChain {
    param(
        [System.Exception]$Exception,
        [string]$Indent = "  "
    )

    $current = $Exception
    $depth = 0
    while ($current -ne $null -and $depth -lt 10) {
        Write-Report ("{0}- {1}: {2}" -f $Indent, $current.GetType().FullName, $current.Message)
        $current = $current.InnerException
        $depth += 1
    }
}

function Get-TargetPort {
    param([System.Uri]$Uri)

    if ($Uri.Port -gt 0) {
        return $Uri.Port
    }

    if ($Uri.Scheme -eq "http") {
        return 80
    }

    return 443
}

function Test-InternalIssuer {
    param([string]$Issuer)

    if ([string]::IsNullOrWhiteSpace($Issuer)) {
        return $false
    }

    $lower = $Issuer.ToLowerInvariant()
    $keywords = @(
        "internal",
        "corp",
        "corporate",
        "proxy",
        "zscaler",
        "netskope",
        "microsoft",
        "active directory",
        "domain ca",
        "ssl inspection",
        "fortinet",
        "palo alto",
        "checkpoint",
        "cisco umbrella"
    )

    foreach ($keyword in $keywords) {
        if ($lower.Contains($keyword)) {
            return $true
        }
    }

    return $false
}

function Find-OpenSsl {
    try {
        $command = Get-Command openssl -ErrorAction SilentlyContinue
        if ($command -ne $null -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
            return $command.Source
        }
    }
    catch {
    }

    $paths = @(
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\Git\mingw64\bin\openssl.exe",
        "C:\Program Files (x86)\Git\usr\bin\openssl.exe",
        "C:\Program Files (x86)\Git\mingw64\bin\openssl.exe"
    )

    foreach ($path in $paths) {
        try {
            if (Test-Path -LiteralPath $path) {
                return $path
            }
        }
        catch {
        }
    }

    return $null
}

function Invoke-DnsProbe {
    param([string]$TargetHost)

    Write-Report "DNS:"
    try {
        $resolveCommand = Get-Command Resolve-DnsName -ErrorAction SilentlyContinue
        if ($resolveCommand -ne $null) {
            Write-Report "  Engine: Resolve-DnsName"
            try {
                $records = Resolve-DnsName -Name $TargetHost -ErrorAction Stop
                if ($records -eq $null) {
                    Write-Report "  No records returned."
                    Add-VerdictHint ("LIKELY DNS ISSUE: {0} returned no DNS records." -f $TargetHost)
                    return
                }

                foreach ($record in $records) {
                    $parts = @()
                    if ($record.Name -ne $null) { $parts += ("name={0}" -f $record.Name) }
                    if ($record.Type -ne $null) { $parts += ("type={0}" -f $record.Type) }
                    if ($record.IPAddress -ne $null) { $parts += ("address={0}" -f $record.IPAddress) }
                    if ($record.NameHost -ne $null) { $parts += ("target={0}" -f $record.NameHost) }
                    if ($record.QueryType -ne $null -and $record.Type -eq $null) { $parts += ("type={0}" -f $record.QueryType) }
                    if ($parts.Count -eq 0) { $parts += ($record | Out-String).Trim() }
                    Write-Report ("  - {0}" -f ($parts -join " | "))
                }
                return
            }
            catch {
                Write-Report ("  Resolve-DnsName failed or NXDOMAIN: {0}" -f $_.Exception.Message)
                Write-Report "  Falling back to [System.Net.Dns]::GetHostAddresses."
            }
        }
        else {
            Write-Report "  Engine: [System.Net.Dns]::GetHostAddresses (Resolve-DnsName unavailable)"
        }

        try {
            $addresses = [System.Net.Dns]::GetHostAddresses($TargetHost)
            if ($addresses -eq $null -or $addresses.Count -eq 0) {
                Write-Report "  No addresses returned."
                Add-VerdictHint ("LIKELY DNS ISSUE: {0} returned no DNS records." -f $TargetHost)
                return
            }

            foreach ($address in $addresses) {
                Write-Report ("  - address={0}" -f $address.IPAddressToString)
            }
        }
        catch {
            Write-Report ("  NXDOMAIN or DNS lookup failed: {0}" -f $_.Exception.Message)
            Add-VerdictHint ("LIKELY DNS ISSUE: {0} did not resolve." -f $TargetHost)
        }
    }
    catch {
        Write-Report "  DNS probe failed unexpectedly:"
        Write-ExceptionChain -Exception $_.Exception -Indent "    "
    }
}

function Invoke-TcpProbe {
    param(
        [string]$TargetHost,
        [int]$Port
    )

    Write-Report "TCP:"
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(5000, $false)
        if (-not $connected) {
            try { $client.Close() } catch { }
            Write-Report ("  FAILED: timeout connecting to {0}:{1}." -f $TargetHost, $Port)
            Add-VerdictHint ("LIKELY NETWORK/FIREWALL ISSUE: TCP {0}:{1} timed out." -f $TargetHost, $Port)
            return
        }

        $client.EndConnect($async)
        Write-Report ("  OK: connected to {0}:{1}." -f $TargetHost, $Port)
    }
    catch {
        Write-Report ("  FAILED: could not connect to {0}:{1}." -f $TargetHost, $Port)
        Write-ExceptionChain -Exception $_.Exception -Indent "    "
        Add-VerdictHint ("LIKELY NETWORK/FIREWALL ISSUE: TCP {0}:{1} failed." -f $TargetHost, $Port)
    }
    finally {
        if ($client -ne $null) {
            try { $client.Close() } catch { }
        }
    }
}

function Invoke-TlsProbe {
    param(
        [string]$TargetHost,
        [int]$Port,
        [string]$ExpectedIssuerMatch
    )

    Write-Report "TLS handshake and certificate chain:"
    $client = $null
    $sslStream = $null
    $capture = New-Object PSObject -Property @{
        CallbackSeen = $false
        LeafSubject = ""
        LeafIssuer = ""
        LeafThumbprint = ""
        LeafNotAfter = ""
        PolicyErrors = ""
        ChainElements = @()
        ChainStatusFlags = @()
        ChainStatusLines = @()
    }

    try {
        $callback = {
            param($sender, $certificate, $chain, $sslPolicyErrors)

            $capture.CallbackSeen = $true
            $capture.PolicyErrors = $sslPolicyErrors.ToString()

            if ($certificate -ne $null) {
                $leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $certificate
                $capture.LeafSubject = $leaf.Subject
                $capture.LeafIssuer = $leaf.Issuer
                $capture.LeafThumbprint = $leaf.Thumbprint
                $capture.LeafNotAfter = $leaf.NotAfter.ToString("u")
            }

            if ($chain -ne $null) {
                $elements = @()
                foreach ($element in $chain.ChainElements) {
                    $elements += ("subject={0} | issuer={1}" -f $element.Certificate.Subject, $element.Certificate.Issuer)
                }
                $capture.ChainElements = $elements

                $statusFlags = @()
                $statusLines = @()
                foreach ($status in $chain.ChainStatus) {
                    $statusFlags += $status.Status.ToString()
                    $statusLines += ("{0}: {1}" -f $status.Status, $status.StatusInformation.Trim())
                }
                $capture.ChainStatusFlags = $statusFlags
                $capture.ChainStatusLines = $statusLines
            }

            return $true
        }

        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(10000, $false)
        if (-not $connected) {
            try { $client.Close() } catch { }
            Write-Report ("  FAILED: timeout connecting to {0}:{1} before TLS." -f $TargetHost, $Port)
            Add-VerdictHint ("LIKELY NETWORK/FIREWALL ISSUE: TLS TCP connect to {0}:{1} timed out." -f $TargetHost, $Port)
            return
        }

        $client.EndConnect($async)
        $client.ReceiveTimeout = 10000
        $client.SendTimeout = 10000
        $networkStream = $client.GetStream()
        $networkStream.ReadTimeout = 10000
        $networkStream.WriteTimeout = 10000
        $sslStream = New-Object System.Net.Security.SslStream -ArgumentList @($networkStream, $false, ([System.Net.Security.RemoteCertificateValidationCallback]$callback))
        $sslStream.AuthenticateAsClient($TargetHost)

        Write-Report "  Handshake: completed. The validation callback accepted the cert for diagnostics; policy errors below are the real validation result."
    }
    catch {
        Write-Report "  Handshake: FAILED. Exception chain:"
        Write-ExceptionChain -Exception $_.Exception -Indent "    "
        Add-VerdictHint ("TLS HANDSHAKE FAILED: {0}:{1} did not complete TLS negotiation." -f $TargetHost, $Port)
    }
    finally {
        if ($sslStream -ne $null) { try { $sslStream.Dispose() } catch { } }
        if ($client -ne $null) { try { $client.Close() } catch { } }
    }

    if ($capture.CallbackSeen) {
        Write-Report ("  Leaf subject: {0}" -f $capture.LeafSubject)
        Write-Report ("  Leaf issuer: {0}" -f $capture.LeafIssuer)
        Write-Report ("  Leaf thumbprint: {0}" -f $capture.LeafThumbprint)
        Write-Report ("  Leaf notAfter: {0}" -f $capture.LeafNotAfter)
        Write-Report ("  SslPolicyErrors: {0}" -f $capture.PolicyErrors)

        Write-Report "  Chain elements:"
        if ($capture.ChainElements.Count -eq 0) {
            Write-Report "    (none captured)"
        }
        else {
            $elementIndex = 0
            foreach ($elementLine in $capture.ChainElements) {
                $elementIndex += 1
                Write-Report ("    [{0}] {1}" -f $elementIndex, $elementLine)
            }
        }

        Write-Report "  Chain status:"
        if ($capture.ChainStatusLines.Count -eq 0) {
            Write-Report "    (none)"
        }
        else {
            foreach ($statusLine in $capture.ChainStatusLines) {
                Write-Report ("    - {0}" -f $statusLine)
            }
        }

        if (-not [string]::IsNullOrWhiteSpace($ExpectedIssuerMatch) -and $capture.LeafIssuer -notlike ("*{0}*" -f $ExpectedIssuerMatch) -and (Test-InternalIssuer -Issuer $capture.LeafIssuer)) {
            $hint = ("LIKELY TLS INTERCEPTION (proxy re-signing): issuer is {0}, expected {1}" -f $capture.LeafIssuer, $ExpectedIssuerMatch)
            Write-Report ("  {0}" -f $hint)
            Add-VerdictHint $hint
        }

        $hasTrustOrChainProblem = $false
        foreach ($flag in $capture.ChainStatusFlags) {
            if ($flag -match "PartialChain|UntrustedRoot") {
                $hasTrustOrChainProblem = $true
            }
        }

        if ($hasTrustOrChainProblem) {
            $hint = "LIKELY MISSING INTERMEDIATE OR UNTRUSTED ROOT"
            Write-Report ("  {0}" -f $hint)
            Add-VerdictHint ("{0}: {1}" -f $hint, $TargetHost)
        }
    }
    else {
        Write-Report "  No certificate callback data was captured."
    }
}

function Invoke-OpenSslProbe {
    param(
        [string]$TargetHost,
        [int]$Port
    )

    Write-Report "Served-chain probe with openssl:"
    try {
        $opensslPath = Find-OpenSsl
        if ([string]::IsNullOrWhiteSpace($opensslPath)) {
            Write-Report "  SKIPPED: openssl not found on PATH or common Git-for-Windows paths."
            return
        }

        Write-Report ("  Engine: {0}" -f $opensslPath)
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo.FileName = $opensslPath
        $process.StartInfo.Arguments = ('s_client -showcerts -connect "{0}:{1}" -servername "{0}"' -f $TargetHost, $Port)
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.CreateNoWindow = $true

        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        try { $process.StandardInput.Close() } catch { }

        $exited = $process.WaitForExit(10000)
        if (-not $exited) {
            try { $process.Kill() } catch { }
            Write-Report "  FAILED: openssl s_client timed out after 10 seconds."
            return
        }

        $process.WaitForExit()
        $output = $stdoutTask.Result + $stderrTask.Result
        $certCount = ([regex]::Matches($output, "-----BEGIN CERTIFICATE-----")).Count
        Write-Report ("  Certificates served by server: {0}" -f $certCount)

        $openSslSubject = ""
        $openSslIssuer = ""
        foreach ($line in ($output -split "`r?`n")) {
            if ([string]::IsNullOrWhiteSpace($openSslSubject) -and $line -match "^subject=(.*)$") {
                $openSslSubject = $matches[1].Trim()
            }
            if ([string]::IsNullOrWhiteSpace($openSslIssuer) -and $line -match "^issuer=(.*)$") {
                $openSslIssuer = $matches[1].Trim()
            }
        }

        if ($certCount -eq 1) {
            if (-not [string]::IsNullOrWhiteSpace($openSslSubject) -and $openSslSubject -eq $openSslIssuer) {
                $hint = ("UNTRUSTED SELF-SIGNED LEAF: {0}:{1} served one self-signed certificate." -f $TargetHost, $Port)
            }
            else {
                $hint = ("MISSING INTERMEDIATE CONFIRMED BY OPENSSL: {0}:{1} served one certificate (leaf only)." -f $TargetHost, $Port)
            }
            Write-Report ("  {0}" -f $hint)
            Add-VerdictHint $hint
        }
        elseif ($certCount -gt 1) {
            Write-Report "  Server served more than one certificate. If clients still fail, inspect trust roots or interception."
        }
        else {
            Write-Report "  No PEM certificates found in openssl output."
        }

        $interestingLines = @()
        foreach ($line in ($output -split "`r?`n")) {
            if ($line -match "^(depth=|verify error:|Verify return code:|subject=|issuer=)") {
                $interestingLines += $line
            }
        }

        if ($interestingLines.Count -gt 0) {
            Write-Report "  OpenSSL summary lines:"
            foreach ($line in ($interestingLines | Select-Object -First 12)) {
                Write-Report ("    {0}" -f $line)
            }
        }
    }
    catch {
        Write-Report "  OpenSSL probe failed:"
        Write-ExceptionChain -Exception $_.Exception -Indent "    "
    }
}

function Invoke-ProxyProbe {
    param([System.Uri]$Uri)

    Write-Report "Proxy:"
    try {
        $netshCommand = Get-Command netsh -ErrorAction SilentlyContinue
        if ($netshCommand -ne $null) {
            try {
                $netshOutput = netsh winhttp show proxy 2>&1 | Out-String
                Write-Report "  netsh winhttp show proxy:"
                foreach ($line in ($netshOutput -split "`r?`n")) {
                    if (-not [string]::IsNullOrWhiteSpace($line)) {
                        Write-Report ("    {0}" -f $line)
                    }
                }
                if ($netshOutput -and $netshOutput -notmatch "Direct access") {
                    Add-VerdictHint "PROXY DETECTED: WinHTTP proxy is configured."
                }
            }
            catch {
                Write-Report ("  netsh failed: {0}" -f $_.Exception.Message)
            }
        }
        else {
            Write-Report "  netsh unavailable on this host."
        }

        try {
            $proxy = [System.Net.WebRequest]::DefaultWebProxy
            if ($proxy -eq $null) {
                Write-Report "  DefaultWebProxy: none"
                return
            }

            $proxyUri = $proxy.GetProxy($Uri)
            if ($proxyUri -eq $null) {
                Write-Report "  DefaultWebProxy.GetProxy: none"
            }
            elseif ($proxyUri.AbsoluteUri -eq $Uri.AbsoluteUri) {
                Write-Report ("  DefaultWebProxy.GetProxy({0}): direct" -f $Uri.AbsoluteUri)
            }
            else {
                $hint = ("PROXY DETECTED: DefaultWebProxy routes {0} via {1}" -f $Uri.AbsoluteUri, $proxyUri.AbsoluteUri)
                Write-Report ("  {0}" -f $hint)
                Add-VerdictHint $hint
            }
        }
        catch {
            Write-Report "  DefaultWebProxy probe failed:"
            Write-ExceptionChain -Exception $_.Exception -Indent "    "
        }
    }
    catch {
        Write-Report "  Proxy probe failed unexpectedly:"
        Write-ExceptionChain -Exception $_.Exception -Indent "    "
    }
}

function Write-EnvironmentReport {
    Write-Report "===== ENVIRONMENT ====="
    try {
        $editionText = "Desktop"
        if ($PSVersionTable.ContainsKey("PSEdition")) {
            $editionText = $PSVersionTable.PSEdition
        }
        Write-Report ("PowerShell: {0} ({1})" -f $PSVersionTable.PSVersion.ToString(), $editionText)
        if ($PSVersionTable.PSVersion.Major -le 5) {
            Write-Report "Compatibility: Windows PowerShell 5.1-compatible mode."
        }
        else {
            Write-Report "Compatibility: running on newer PowerShell; script avoids PS7-only syntax/APIs and prints fallbacks used."
        }
    }
    catch {
        Write-Report ("PowerShell: unable to read PSVersionTable: {0}" -f $_.Exception.Message)
    }

    try {
        Write-Report ("OS: {0}" -f [System.Environment]::OSVersion.VersionString)
    }
    catch {
        Write-Report ("OS: unable to read OSVersion: {0}" -f $_.Exception.Message)
    }

    try {
        $nodeExtraCaCerts = [System.Environment]::GetEnvironmentVariable("NODE_EXTRA_CA_CERTS")
        if ([string]::IsNullOrWhiteSpace($nodeExtraCaCerts)) {
            Write-Report "NODE_EXTRA_CA_CERTS: not set"
        }
        else {
            Write-Report ("NODE_EXTRA_CA_CERTS: {0}" -f $nodeExtraCaCerts)
        }
    }
    catch {
        Write-Report ("NODE_EXTRA_CA_CERTS: unable to read: {0}" -f $_.Exception.Message)
    }

    Write-Report "Features used: Resolve-DnsName if available; [System.Net.Dns] fallback; TcpClient timeout; System.Net.Security.SslStream diagnostic callback; openssl if available."
    Write-Report ""
}

function Invoke-UrlProbe {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return
    }

    Write-Report ("===== URL: {0} =====" -f $Url)
    try {
        $uri = New-Object System.Uri -ArgumentList $Url
        $targetHost = $uri.DnsSafeHost
        $port = Get-TargetPort -Uri $uri
        Write-Report ("Parsed target: host={0} port={1} scheme={2}" -f $targetHost, $port, $uri.Scheme)

        Invoke-DnsProbe -TargetHost $targetHost
        Invoke-TcpProbe -TargetHost $targetHost -Port $port
        Invoke-TlsProbe -TargetHost $targetHost -Port $port -ExpectedIssuerMatch $ExpectedIssuerMatch
        Invoke-OpenSslProbe -TargetHost $targetHost -Port $port
        Invoke-ProxyProbe -Uri $uri
    }
    catch {
        Write-Report "URL probe failed unexpectedly:"
        Write-ExceptionChain -Exception $_.Exception -Indent "  "
        Add-VerdictHint ("URL PROBE FAILED: {0}" -f $Url)
    }
    Write-Report ""
}

$timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
$emdash = [char]0x2014
Write-Report ("OpenWork Network Doctor v1 {0} {1}" -f $emdash, $timestamp)
Write-Report "This entire output is safe to copy/paste back to OpenWork support."
Write-Report ("Expected issuer match: {0}" -f $ExpectedIssuerMatch)
if ([string]::IsNullOrWhiteSpace($WebUrl)) {
    Write-Report "WebUrl: (empty; skipped)"
}
else {
    Write-Report ("WebUrl: {0}" -f $WebUrl)
}
if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
    Write-Report "ApiUrl: (empty; skipped)"
}
else {
    Write-Report ("ApiUrl: {0}" -f $ApiUrl)
}
Write-Report ""

Write-EnvironmentReport
Invoke-UrlProbe -Url $WebUrl
if (-not [string]::IsNullOrWhiteSpace($ApiUrl)) {
    Invoke-UrlProbe -Url $ApiUrl
}

Write-Report "===== VERDICT HINTS ====="
if ($script:VerdictHints.Count -eq 0) {
    Write-Report "- No likely root cause was detected by this script. If the app still fails, send this full report to OpenWork support."
}
else {
    foreach ($hint in $script:VerdictHints) {
        Write-Report ("- {0}" -f $hint)
    }
}
Write-Report "===== COPY EVERYTHING ABOVE THIS LINE ====="
