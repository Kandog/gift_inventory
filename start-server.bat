@echo off
rem Starts the Gift Inventory server (API + dashboard). No administrator rights needed.
rem Double-click this file, or run it from a Command Prompt. Close the window or press Ctrl+C to stop.
rem
rem The first start creates a private Python environment in apps\server-py\.venv and installs
rem the packages the server needs (openpyxl for Excel, reportlab for label PDFs,
rem cryptography for the HTTPS certificate).

setlocal
cd /d "%~dp0"
title Gift Inventory server

rem ---- Settings: change these if needed ----
if not defined GIFTS_PORT set GIFTS_PORT=8080
rem HTTPS port for the phone web app (https://this-PC:8443/app). Set to 0 to turn it off.
if not defined GIFTS_HTTPS_PORT set GIFTS_HTTPS_PORT=8443
rem Uncomment to keep the data somewhere else (default: the "data" folder next to this file).
rem set GIFTS_DATA_DIR=D:\GiftInventoryData

set "SERVER=%~dp0apps\server-py"
set "VENV=%SERVER%\.venv"
set "PY=%VENV%\Scripts\python.exe"

if exist "%PY%" goto :deps

echo Setting up Python for the first time...
set "BASEPY="
where py >nul 2>nul && set "BASEPY=py -3"
if not defined BASEPY where python >nul 2>nul && set "BASEPY=python"
if not defined BASEPY (
  echo.
  echo Python is not installed. Install Python 3.10 or newer from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" in the installer. Then run this file again.
  pause
  exit /b 1
)
%BASEPY% -m venv "%VENV%"
if errorlevel 1 (
  echo Could not create the Python environment in "%VENV%".
  pause
  exit /b 1
)

:deps
rem Install packages only when requirements.txt changed since the last install.
fc /b "%SERVER%\requirements.txt" "%VENV%\installed-requirements.txt" >nul 2>nul
if not errorlevel 1 goto :run
echo Installing server packages...
"%PY%" -m pip install --disable-pip-version-check -q -r "%SERVER%\requirements.txt"
if errorlevel 1 (
  echo.
  echo Installing packages failed. Check the internet connection and run this file again.
  pause
  exit /b 1
)
copy /y "%SERVER%\requirements.txt" "%VENV%\installed-requirements.txt" >nul

:run
"%PY%" "%SERVER%\main.py"
echo.
echo The server has stopped.
pause
