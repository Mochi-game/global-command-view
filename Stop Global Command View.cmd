@echo off
title Global Command View - stop
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
ping -n 3 127.0.0.1 >nul 2>&1
