@echo off
title Global Command View - stop
cd /d "%~dp0"

rem Works wherever you put it, including a copy on the Desktop.
rem
rem This used to call stop.ps1 beside it and nothing else. Copy the icon to the
rem Desktop - exactly what somebody wanting a stop button does - and it looked
rem for stop.ps1 on the Desktop, did not find it, and printed PowerShell's own
rem complaint about a -File argument that does not exist. Reported that way.
rem
rem Stopping needs no files: whoever is listening on port 8820 is the server. So
rem the script beside it is used when it is there, and the same thing is done
rem inline when it is not.
rem
rem The inline version has no pipe characters in it on purpose. Written with
rem them first, escaped as ^^| inside the quotes, which is not an escape at all
rem there - PowerShell received a literal ^^| and quietly matched nothing, so
rem the button reported "Nothing was running" while the server carried on. A
rem foreach loop needs no pipes and cannot be mangled on the way through cmd.

if exist "%~dp0stop.ps1" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
  goto :done
)

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$killed = @(); for ($pass = 1; $pass -le 3; $pass++) { try { foreach ($c in Get-NetTCPConnection -LocalPort 8820 -State Listen -ErrorAction Stop) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'python') { Stop-Process -Id $c.OwningProcess -Force; $killed += $c.OwningProcess } } } catch { }; if (-not (Get-NetTCPConnection -LocalPort 8820 -State Listen -ErrorAction SilentlyContinue)) { break } }; if ($killed.Count -gt 0) { Write-Host ('  Stopped ' + $killed.Count + ' server process(es): ' + ($killed -join ', ')) } else { Write-Host '  Nothing was running.' }"

:done
ping -n 3 127.0.0.1 >nul 2>&1
