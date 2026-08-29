@echo off
title Global Command View
cd /d "%~dp0"

rem The work is in start.ps1, the same way stopping is in stop.ps1.
rem
rem This file exists because a .ps1 cannot be double-clicked - Windows opens it
rem in Notepad - so something has to be the thing you click. Bypass is here
rem because the script beside it is unsigned and, on a fresh download, still
rem carries the mark that stops PowerShell running it at all.
rem
rem The window you are looking at closes on its own once the server answers.
rem The server itself runs with no window; use the stop icon to shut it down.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
exit /b %errorlevel%
