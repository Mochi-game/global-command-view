@echo off
setlocal enabledelayedexpansion
title Global Command View - install
cd /d "%~dp0"

rem Installer for people who do not have Python and should not have to care.
rem
rem NO ADMINISTRATOR RIGHTS ARE NEEDED. Everything here installs per-user:
rem winget with --scope user, or the python.org installer with
rem InstallAllUsers=0. If Windows ever asks you to elevate while running this,
rem something is wrong and you should say no.
rem
rem It asks before it downloads anything, and says what and from where. An
rem installer that fetches an executable without telling you is indistinguishable
rem from something you would not want, so this one tells you.

echo.
echo   GLOBAL COMMAND VIEW
echo   ---------------------------------------------------------------
echo.

rem ------------------------------------------------- trust these files
rem Everything out of a downloaded ZIP carries Windows' Mark of the Web,
rem which is what makes the launchers raise SmartScreen and what stops
rem stop.ps1 running at all. This takes it off, and it runs first rather
rem than last so a folder is left trusted even if the install below fails.
rem Bypass is needed for this one call because the script it runs is itself
rem still marked at this point - that is the thing being fixed.
if exist "%~dp0Trust these files.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Trust these files.ps1"
)

rem ---------------------------------------------------------------- python?
set "PY="
for %%C in (py python python3) do (
  if not defined PY (
    %%C -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" >nul 2>&1 && set "PY=%%C"
  )
)

if defined PY (
  for /f "delims=" %%V in ('!PY! -c "import sys;print(sys.version.split()[0])" 2^>nul') do set "PYVER=%%V"
  echo   Python !PYVER! is already here. Nothing to install.
  echo.
  goto :ready
)

echo   Python is not installed, and this needs it.
echo.
echo   Python is the free, open-source language this app is written in. It
echo   comes from the Python Software Foundation at python.org.
echo.
echo   This will install it FOR YOUR USER ACCOUNT ONLY. That means:
echo.
echo     - no administrator rights are needed
echo     - nothing outside your own user folder is touched
echo     - other people on this computer are unaffected
echo.
echo   If Windows asks you to elevate at any point, say no and tell me.
echo.
set /p "OK=  Install Python now? [y/N] "
if /i not "!OK!"=="y" (
  echo.
  echo   Nothing was installed. You can get Python yourself from
  echo   https://www.python.org/downloads/ and run this again afterwards.
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------- try winget first
echo.
where winget >nul 2>&1
if %errorlevel% equ 0 (
  echo   Using winget, which is built into Windows.
  echo   Package: Python.Python.3.12 from the Python Software Foundation.
  echo.
  winget install --id Python.Python.3.12 --scope user --silent ^
    --accept-package-agreements --accept-source-agreements
  call :recheck
  if defined PY goto :installed
  echo.
  echo   winget did not manage it. Falling back to python.org.
  echo.
)

rem --------------------------------------------- fall back to python.org
set "PYURL=https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
set "PYEXE=%TEMP%\python-3.12.10-amd64.exe"

echo   Downloading from python.org. This is about 26 MB.
echo   %PYURL%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%PYURL%' -OutFile '%PYEXE%' -UseBasicParsing; exit 0 } catch { exit 1 }"
if not exist "%PYEXE%" (
  echo.
  echo   The download did not work. Get Python yourself from
  echo   https://www.python.org/downloads/ - tick "Add python.exe to PATH"
  echo   on the first screen - and run this again afterwards.
  echo.
  pause
  exit /b 1
)

echo   Installing, for your user account only. This takes a minute.
echo.
"%PYEXE%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0
del "%PYEXE%" >nul 2>&1
call :recheck

:installed
if not defined PY (
  echo.
  echo   Python was installed but this window cannot see it yet. Windows only
  echo   hands a new PATH to new windows.
  echo.
  echo   CLOSE THIS WINDOW and double-click Start Global Command View.cmd.
  echo.
  pause
  exit /b 0
)
echo.
echo   Python is in. Starting.
echo.

rem ------------------------------------------------------------------ go
:ready
echo   The browser opens by itself in a moment.
echo   Close this window, or use the stop icon, to shut down.
echo.
"%PY%" "%~dp0server.py" --port 8820
echo.
echo   Server stopped.
ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0

rem ------------------------------------------------------------- helpers
:recheck
rem A fresh install is not on this window's PATH, so look where it lands too.
set "PY="
for %%C in (py python python3) do (
  if not defined PY (
    %%C -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" >nul 2>&1 && set "PY=%%C"
  )
)
if not defined PY (
  for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if not defined PY if exist "%%D\python.exe" set "PY=%%D\python.exe"
  )
)
exit /b 0
