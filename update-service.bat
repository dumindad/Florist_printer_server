@echo off
echo ============================================
echo  POS Printer Server - Update
echo ============================================
echo.

set "TARGET_DIR=C:\POSPrinterServer"
set "UPDATE_FILE=%TARGET_DIR%\printer-server-new.exe"

if not exist "%UPDATE_FILE%" (
    echo ERROR: New version file not found.
    echo Please place the new printer-server.exe as printer-server-new.exe
    echo in %TARGET_DIR%
    pause
    exit /b 1
)

echo [1/4] Stopping service...
nssm stop POSPrinterServer
if %errorlevel% neq 0 (
    echo WARNING: Could not stop service (may already be stopped)
)

echo [2/4] Backing up old version...
if exist "%TARGET_DIR%\printer-server.exe" (
    move "%TARGET_DIR%\printer-server.exe" "%TARGET_DIR%\printer-server-old.exe"
)

echo [3/4] Installing new version...
move "%UPDATE_FILE%" "%TARGET_DIR%\printer-server.exe"

echo [4/4] Starting service...
nssm start POSPrinterServer

echo.
echo ============================================
echo  Update Complete!
echo ============================================
pause
