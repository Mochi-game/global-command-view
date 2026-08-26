@echo off
title Global Command View - check
cd /d "%~dp0"

echo.
echo   Global Command View - check
echo   ---------------------------------------------
echo   Reads the files, then calls every feed.
echo.

rem Prefer the server that is already up: testing the one actually in use beats
rem testing a fresh copy of it. If nothing is listening, smoke.py starts its own
rem on a free port and shuts it down afterwards.
set PORTARG=
netstat -ano | findstr /R /C:"LISTENING" | findstr /C:":8820 " >nul 2>&1
if not errorlevel 1 (
  echo   Found the app running on 8820 - checking that one.
  echo.
  set PORTARG=--port 8820
)

python "%~dp0smoke.py" --quick %PORTARG%
set RESULT=%ERRORLEVEL%

echo.
if "%RESULT%"=="0" (
  echo   ---------------------------------------------
  echo   Nothing broken. It boots and every feed answers.
  echo.
  echo   This does not say the picture looks right - that
  echo   still needs your eyes. Open the app and check the
  echo   briefing has entries and the optics switch.
) else (
  echo   ---------------------------------------------
  echo   Something is wrong. The lines above name it.
  echo   Do not record until it is clear.
)

echo.
echo   Press any key to close.
pause >nul
