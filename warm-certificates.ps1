<#
  Teach Windows the certificates this app needs, before it needs them.

  The problem this exists for, reported from a fresh Windows install: radio,
  airports, runways, weather and beacons all empty, while shortwave, APRS and
  aircraft worked. The app said "certificate verify failed: unable to get local
  issuer certificate", which sounds like a broken app or a missing key and is
  neither.

  What is actually happening. Windows does not ship every root certificate; it
  fetches one the first time something asks for it, through CryptoAPI. A browser
  asks. PowerShell asks, because .NET validates through CryptoAPI too. Python
  does not - it copies whatever is already in the store and validates with
  OpenSSL, so on a machine where the root was never fetched, Python fails and
  everything else on that machine looks fine.

  So this asks on Python's behalf. One TLS handshake per host, no HTTP request,
  which is all it takes to make Windows go and get the root - and then Python
  finds it in the store on the next start.

  It runs once. The installer calls it, and the launcher calls it if the marker
  beside it is missing, so somebody who unpacked the ZIP without installing is
  not left out. Nothing is downloaded into the app, nothing is trusted that
  Windows would not have trusted anyway, and no administrator rights are needed:
  this triggers the same fetch that visiting the site in Edge would.

  It cannot help on a machine that is blocked from reaching Windows Update's
  certificate list, and it cannot help where antivirus or a company proxy is
  re-signing HTTPS with a certificate Windows does not trust. Those need a
  person. The app says so when it hits them.
#>

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$marker = Join-Path $here '.certificates-warmed'

# Not all fifty-six hosts the app talks to. Certificates are issued by a handful
# of authorities and shared across hosts, so these are chosen to cover the
# authorities behind the layers that work without any key - the ones a first-run
# user sees. Anything still missing announces itself in the app with the address
# to open.
$hosts = @(
    'de1.api.radio-browser.info'      # radio stations
    'davidmegginson.github.io'        # airports, runways, beacons, frequencies
    'aviationweather.gov'             # airfield weather
    'api.openmhz.com'                 # police and fire radio
    'ais.openwaters.io'               # vessels, open network
    'meri.digitraffic.fi'             # vessels and cameras, Baltic
    'opensky-network.org'             # aircraft
    'api.adsb.lol'                    # aircraft registry
    'earthquake.usgs.gov'             # earthquakes
    'firms.modaps.eosdis.nasa.gov'    # fires
    'nominatim.openstreetmap.org'     # place names
    'overpass-api.de'                 # buildings, taxiways, infrastructure
    'celestrak.org'                   # satellites
    'en.wikipedia.org'                # ship and place summaries
    'commons.wikimedia.org'           # photographs
    'www.submarinecablemap.com'       # cables
    'api.gdeltproject.org'            # news attention
    'services.arcgisonline.com'       # the base map
    'volcano.si.edu'                  # eruptions
    'www.gdacs.org'                   # disaster alerts
)

# All at once, not one after another.
#
# Sequentially this took twenty-seven seconds for twenty hosts, which is too
# much to add to an install and far too much to add to a launch. They do not
# depend on each other, so they all go at the same time and the whole thing
# costs about as long as the slowest single host.
$pool = [RunspaceFactory]::CreateRunspacePool(1, 12)
$pool.Open()

$work = {
    param($name)
    $tcp = $null; $ssl = $null
    try {
        # A handshake, not a request. Validating the chain is what makes
        # CryptoAPI go and fetch a missing root, and that is the whole point;
        # the HTTP response underneath would only cost time.
        $tcp = New-Object System.Net.Sockets.TcpClient
        if (-not $tcp.ConnectAsync($name, 443).Wait(5000)) { return 'unreachable' }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false)
        $ssl.AuthenticateAsClient($name)
        return 'ok'
    } catch {
        # A host that is slow or down is not a certificate problem, and saying
        # so would send somebody hunting a fault that is not theirs. Only a
        # rejected chain counts.
        $m = $_.Exception.ToString()
        if ($m -match 'trust|certificate|SSL|authentication') { return 'cert' }
        return 'unreachable'
    }
    finally {
        if ($ssl) { $ssl.Dispose() }
        if ($tcp) { $tcp.Close() }
    }
}

$running = @()
foreach ($h in $hosts) {
    $ps = [PowerShell]::Create().AddScript($work).AddArgument($h)
    $ps.RunspacePool = $pool
    $running += [pscustomobject]@{ name = $h; ps = $ps; handle = $ps.BeginInvoke() }
}

$ok = 0
$rejected = @()
$unreachable = @()
foreach ($r in $running) {
    $result = 'unreachable'
    try { $result = "$($r.ps.EndInvoke($r.handle) | Select-Object -Last 1)" } catch { }
    if ($result -eq 'ok') { $ok++ }
    elseif ($result -eq 'cert') { $rejected += $r.name }
    else { $unreachable += $r.name }
    $r.ps.Dispose()
}
$pool.Close(); $pool.Dispose()

if ($rejected.Count -eq 0) {
    Write-Host "  Certificates: $ok verified." -ForegroundColor DarkGray
    if ($unreachable.Count) {
        Write-Host "  ($($unreachable.Count) host(s) did not answer in time - slow or down, not a"
        Write-Host '   certificate problem, and nothing to do about it here.)' -ForegroundColor DarkGray
    }
} else {
    Write-Host "  Certificates: $($rejected.Count) could not be verified." -ForegroundColor Yellow
    foreach ($h in $rejected) { Write-Host "    $h" }
    Write-Host '  Those layers will be empty. If it is most of them, something is'
    Write-Host '  inspecting HTTPS - antivirus with "scan encrypted connections"'
    Write-Host '  switched on, or a company proxy - and its certificate has to be'
    Write-Host '  trusted by Windows.'
}

try {
    Set-Content -LiteralPath $marker -Encoding UTF8 -Value @"
Windows was asked to fetch the certificate authorities this app needs, so that
Python can verify them. Written by warm-certificates.ps1.

$(Get-Date -Format 'yyyy-MM-dd HH:mm')  $ok of $($hosts.Count) verified
$(if ($rejected.Count) { "rejected: " + ($rejected -join ', ') } else { "" })

Delete this file to make the launcher try again.
"@
} catch { }
