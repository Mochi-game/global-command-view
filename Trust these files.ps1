<#
  Takes the "this came from the internet" mark off the files in this folder.

  Windows attaches a hidden tag called the Mark of the Web to everything that
  comes out of a downloaded ZIP. It is why the launchers raise a SmartScreen box
  and why PowerShell refuses to run stop.ps1: Windows knows the file arrived
  from outside and has no idea whether you meant it to.

  Unblock-File removes that tag. It is Microsoft's own command for exactly this,
  it is what the "Unblock" tick box in a file's Properties dialog does, and it
  changes nothing else - no security setting, no execution policy, no
  SmartScreen configuration, nothing outside this folder. It needs no
  administrator rights, because a mark on your own file is yours to remove.

  Read this before running it. Marking files as trusted is a real decision and
  a script that asks you to trust a folder is exactly the shape of something you
  should be suspicious of. Two things make this one safe to say yes to: it works
  only on the folder it is sitting in, and it refuses to run at all unless the
  app is in that folder. Point it at your Downloads directory and it stops.
#>

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host ''
Write-Host '  GLOBAL COMMAND VIEW - trusting the files in this folder' -ForegroundColor Cyan
Write-Host '  ---------------------------------------------------------------'
Write-Host ''

# The guard. This script is only ever meant to run beside the app, and checking
# for the app's own files is what stops it being copied somewhere broader and
# used to wave through a folder full of things nobody looked at.
if (-not (Test-Path (Join-Path $here 'server.py'))) {
    Write-Host '  server.py is not in this folder, so this is not the app.' -ForegroundColor Yellow
    Write-Host '  Nothing was changed. Move this script back beside server.py.'
    Write-Host ''
    exit 1
}

Write-Host "  Folder: $here"
Write-Host ''

# .cache holds tens of thousands of downloaded feed responses and .git holds the
# repository's internals. Neither is ever executed and walking them would take
# far longer than the part that matters.
$skip = @('.cache', '.git', '__pycache__')

$files = Get-ChildItem -LiteralPath $here -Recurse -File -Force | Where-Object {
    $rel = $_.FullName.Substring($here.Length).TrimStart('\')
    $top = ($rel -split '\\')[0]
    $skip -notcontains $top
}

# Counted before rather than after, because Unblock-File is silent about
# whether it found anything and "17 files were marked" is the useful sentence.
$marked = @($files | Where-Object {
    Get-Item -LiteralPath $_.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
})

if ($marked.Count -eq 0) {
    Write-Host '  Nothing here is marked. These files are already trusted.' -ForegroundColor Green
    Write-Host ''
    exit 0
}

Write-Host "  $($marked.Count) of $($files.Count) files carry the mark:"
Write-Host ''
$marked | Select-Object -First 12 | ForEach-Object {
    Write-Host ('    ' + $_.FullName.Substring($here.Length).TrimStart('\'))
}
if ($marked.Count -gt 12) {
    Write-Host "    ... and $($marked.Count - 12) more"
}
Write-Host ''

$failed = 0
foreach ($f in $marked) {
    try { Unblock-File -LiteralPath $f.FullName -ErrorAction Stop }
    catch { $failed++ }
}

if ($failed -gt 0) {
    Write-Host "  $($marked.Count - $failed) unblocked, $failed could not be." -ForegroundColor Yellow
    Write-Host '  A file that will not unblock is usually open in another program,'
    Write-Host '  or in a folder your account cannot write to. Close things and retry.'
} else {
    Write-Host "  Done. $($marked.Count) files are trusted now." -ForegroundColor Green
    Write-Host '  The launchers will stop raising SmartScreen, and stop.ps1 will run.'
}
Write-Host ''
