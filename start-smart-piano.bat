@echo off
setlocal

set "APP_DIR=%~dp0SmartPianoV2"
set "APP_URL=http://127.0.0.1:8080/"

cd /d "%APP_DIR%"

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Please install Python or start a local static server manually.
    pause
    exit /b 1
)

start "" "%APP_URL%"
python -m http.server 8080
