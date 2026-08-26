@echo off
title Global Command View - server
cd /d "%~dp0"
echo.
echo   Global Command View
echo   ---------------------------------------------
echo   The browser opens by itself in a moment.
echo   Close this window, or use the stop icon, to shut down.
echo.
rem The full path goes on the command line on purpose: it is how the stop
rem script recognises this process if the port lookup ever comes up empty.
python "%~dp0server.py" --port 8820
echo.
echo   Server stopped.
ping -n 4 127.0.0.1 >nul 2>&1
