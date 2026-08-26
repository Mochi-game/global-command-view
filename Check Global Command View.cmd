@echo off
title Global Command View - self check
cd /d "%~dp0"
set "PY="
for %%C in (py python python3) do (
  if not defined PY (
    %%C -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" >nul 2>&1 && set "PY=%%C"
  )
)
if not defined PY goto :nopython
echo.
echo   Global Command View - self check
echo   ---------------------------------------------
echo   Reads the files, calls every feed, says what broke.
echo   A green result means it boots and every source answers,
echo   not that the picture is right. That still needs your eyes.
echo.
set "PORTARG="
if not "%~1"=="" set "PORTARG=--port %~1"
%PY% "%~dp0smoke.py" %PORTARG%
echo.
pause
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
