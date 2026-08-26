@echo off
title Global Command View - server
cd /d "%~dp0"
set "PY="
for %%C in (py python python3) do (
  if not defined PY (
    %%C -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" >nul 2>&1 && set "PY=%%C"
  )
)
if not defined PY goto :nopython
echo.
echo   Global Command View
echo   ---------------------------------------------
echo   The browser opens by itself in a moment.
echo   Close this window, or use the stop icon, to shut down.
echo.
rem The full path goes on the command line on purpose: it is how the stop
rem script recognises this process if the port lookup ever comes up empty.
%PY% "%~dp0server.py" --port 8820
echo.
echo   Server stopped.
ping -n 4 127.0.0.1 >nul 2>&1
exit /b 0

:nopython
echo.
echo   ---------------------------------------------------------------
echo    This needs Python, and it is not installed yet.
echo   ---------------------------------------------------------------
echo.
echo    Python is free and takes about two minutes. Get it from:
echo.
echo        https://www.python.org/downloads/
echo.
echo    On the first screen of the installer there is a checkbox at the
echo    bottom that says "Add python.exe to PATH".
echo.
echo        TICK THAT BOX. Nothing here works without it, and it is off
echo        by default. If you miss it, run the installer again and
echo        choose Modify.
echo.
echo    Then close this window and double-click this file again.
echo.
echo    Already installed? Then Windows cannot see it, which is the same
echo    missing checkbox. Re-run the installer and choose Modify.
echo.
echo   ---------------------------------------------------------------
echo.
pause
exit /b 1
