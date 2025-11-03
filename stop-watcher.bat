@echo off
REM X4 Savegame Watcher - Windows Stop Script

echo X4 Savegame Watcher - Shutdown
echo =================================
echo.

call pm2 stop x4-watcher

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Watcher stopped successfully!
    echo.
    echo To start again, run: start-watcher.bat
    echo To remove completely, run: pm2 delete x4-watcher
    echo.
) else (
    echo.
    echo ERROR: Failed to stop watcher.
    echo Check status with: pm2 status
)

pause
