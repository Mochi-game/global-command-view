# Shut down the Global Command View server.
#
# Whoever holds port 8820 is the server, whatever its command line looks like —
# that is the reliable handle. The command-line match is only a fallback for a
# server started on some other port.

$killed = @()

try {
    $owners = Get-NetTCPConnection -LocalPort 8820 -State Listen -ErrorAction Stop |
              Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($id in $owners) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match 'python') {
            Stop-Process -Id $id -Force
            $killed += $id
        }
    }
} catch {
    # nothing listening on the port; fall through to the command-line sweep
}

$strays = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
          Where-Object { $_.CommandLine -like '*global-command-view*server.py*' -and $killed -notcontains $_.ProcessId }
foreach ($stray in $strays) {
    Stop-Process -Id $stray.ProcessId -Force
    $killed += $stray.ProcessId
}

if ($killed.Count) {
    Write-Host "  Stopped $($killed.Count) server process(es): $($killed -join ', ')"
} else {
    Write-Host "  Nothing was running."
}
