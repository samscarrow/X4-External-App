@echo off
REM X4 Savegame Watcher - Windows Startup Script
REM
REM This script starts the savegame watcher daemon using PM2 on Windows.
REM If PM2 is not installed, it will prompt you to install it.

echo X4 Savegame Watcher - Startup
echo ================================
echo.

REM Check if PM2 is installed
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo PM2 is not installed.
    echo.
    echo Installing PM2 globally...
    call npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo ERROR: Failed to install PM2.
        echo Please run: npm install -g pm2
        pause
        exit /b 1
    )
)

echo Starting X4 Savegame Watcher...
call pm2 start ecosystem.config.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Watcher started successfully!
    echo.
    echo Useful commands:
    echo   pm2 status           - Check watcher status
    echo   pm2 logs x4-watcher  - View logs
    echo   pm2 stop x4-watcher  - Stop the watcher
    echo.
) else (
    echo.
    echo ERROR: Failed to start watcher.
    echo Check the logs with: pm2 logs x4-watcher
    pause
    exit /b 1
)

pause
