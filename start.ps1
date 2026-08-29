# Start the server without leaving a window sitting there.
#
# The launcher used to run the server in the foreground, which meant a console
# window open for as long as the app was up - and closing it was how you shut
# the app down. That works, and it looks like something went wrong: no other
# program on the machine leaves a black box on the taskbar while it runs.
#
# The server runs hidden now. This window stays only while it starts, says so,
# and closes itself the moment the server answers. What it does not do is walk
# away without looking: a server that dies on startup would otherwise leave you
# with no window, no browser and nothing to read. It waits, and if nothing comes
# up it puts the reason on screen.
#
# Use the stop icon to shut it down. There is no window to close any more.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

$port = 8820
$url = "http://127.0.0.1:$port/"
$outLog = Join-Path $here 'server.log'
$errLog = Join-Path $here 'server-error.log'

function Test-Up {
    try {
        # ${url} in braces, not $url followed by a backtick. The backtick form
        # was written first and `a is PowerShell's escape for the bell
        # character, so this asked for /<BEL>pi/version, got a 404, and reported
        # a healthy server as failed to start - with the server's own log
        # printed underneath showing it running perfectly.
        Invoke-WebRequest -Uri "${url}api/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch { return $false }
}

Write-Host ''
Write-Host '  GLOBAL COMMAND VIEW' -ForegroundColor Cyan
Write-Host '  ---------------------------------------------'

# Double-clicking twice should not run two servers. The second one would fail on
# the port anyway, and this way it does something useful instead.
if (Test-Up) {
    Write-Host '  Already running. Opening the browser.'
    Write-Host ''
    Start-Process $url
    Start-Sleep -Milliseconds 800
    exit 0
}

$py = $null
foreach ($c in @('py', 'python', 'python3')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
        & $c -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $py = $c; break }
    }
}

if (-not $py) {
    Write-Host ''
    Write-Host '   This needs Python, and it is not installed yet.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '   Double-click "Install Global Command View.cmd" in this folder.'
    Write-Host '   It installs Python for your account only and needs no'
    Write-Host '   administrator rights.'
    Write-Host ''
    Write-Host '   Or get it yourself from https://www.python.org/downloads/ and'
    Write-Host '   tick "Add python.exe to PATH" on the first screen - it is off'
    Write-Host '   by default and nothing here works without it.'
    Write-Host ''
    Read-Host '   Press Enter to close'
    exit 1
}

Write-Host '  Starting. This window closes by itself.'
Write-Host ''

# Hidden, with both streams on disk. The two cannot share one file - PowerShell
# refuses that - and they are worth keeping apart anyway: one is what the server
# said it was doing and the other is why it stopped.
Start-Process -FilePath $py `
    -ArgumentList "`"$(Join-Path $here 'server.py')`"", '--port', "$port" `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

# Twenty seconds is generous for a local server and short enough that a broken
# one does not leave you waiting. The server opens the browser itself.
$up = $false
foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 500
    if (Test-Up) { $up = $true; break }
}

if ($up) {
    Write-Host '  Up. The browser opens in a moment.' -ForegroundColor Green
    Write-Host '  Use the stop icon in this folder to shut it down.'
    Start-Sleep -Milliseconds 900
    exit 0
}

# Nothing came up, so the useful thing is whatever it said on the way down.
Write-Host '  It did not start.' -ForegroundColor Yellow
Write-Host ''
foreach ($pair in @(@($errLog, 'server-error.log'), @($outLog, 'server.log'))) {
    if ((Test-Path $pair[0]) -and (Get-Item $pair[0]).Length -gt 0) {
        Write-Host "  --- $($pair[1]) ---"
        Get-Content $pair[0] -Tail 15 | ForEach-Object { Write-Host "  $_" }
        Write-Host ''
    }
}
Write-Host '  The most common cause is something else already on port 8820.'
Write-Host '  The stop icon clears an old server that did not shut down.'
Write-Host ''
Read-Host '  Press Enter to close'
exit 1
