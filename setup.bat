@echo off
setlocal enabledelayedexpansion

title POS Printer Server - Setup

echo ============================================
echo  POS Printer Server - One-Click Setup
echo ============================================
echo.

:: ---- Self-Elevate to Admin ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -ArgumentList '%~1' -Verb RunAs" >nul 2>&1
    exit /b 0
)

:: ---- Configuration ----
set "TARGET_DIR=C:\POSPrinterServer"
set "SCRIPT_DIR=%~dp0"
set "VERSION_FILE=%TARGET_DIR%\version.json"

echo [1/8] Creating target directory...
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%TARGET_DIR%\logs" mkdir "%TARGET_DIR%\logs"
if not exist "%TARGET_DIR%\node_modules" mkdir "%TARGET_DIR%\node_modules"

echo [2/8] Installing nssm...
if exist "%SCRIPT_DIR%nssm.exe" (
    copy /Y "%SCRIPT_DIR%nssm.exe" "%TARGET_DIR%\nssm.exe" >nul
    echo   nssm.exe copied
) else (
    echo   WARNING: nssm.exe not found in package
)

echo [3/8] Copying printer server...
copy /Y "%SCRIPT_DIR%printer-server.exe" "%TARGET_DIR%\printer-server.exe" >nul
echo   printer-server.exe

echo [4/8] Copying native modules...
if exist "%SCRIPT_DIR%node_modules\" (
    xcopy /E /I /Y "%SCRIPT_DIR%node_modules\*" "%TARGET_DIR%\node_modules\" >nul
    echo   Native modules copied
)

:: Copy update script
if exist "%SCRIPT_DIR%update-service.bat" (
    copy /Y "%SCRIPT_DIR%update-service.bat" "%TARGET_DIR%\update-service.bat" >nul
    echo   update-service.bat copied
)

echo [5/8] Copying SSL certificates...
if not exist "%TARGET_DIR%\certs" mkdir "%TARGET_DIR%\certs"
if exist "%SCRIPT_DIR%certs\*.pem" (
    copy /Y "%SCRIPT_DIR%certs\*.pem" "%TARGET_DIR%\certs\" >nul
    echo   SSL certificates copied
) else (
    echo   WARNING: No certs found in %SCRIPT_DIR%certs\
)

:: Add self-signed cert to Windows Trusted Root store so browsers trust WSS
echo [6/8] Adding certificate to Trusted Root store...
certutil -addstore -user "Root" "%TARGET_DIR%\certs\localhost+2.pem" >nul 2>&1
if %errorlevel% equ 0 (
    echo   Certificate trusted
) else (
    echo   Note: Certificate trust may already be configured or skipped (continuing)
)

echo [7/8] Installing Windows Service...
cd /d "%TARGET_DIR%"

:: Stop existing service if it exists
sc query POSPrinterServer >nul 2>&1
if %errorlevel% equ 0 (
    echo   Stopping existing service...
    nssm stop POSPrinterServer >nul 2>&1
    timeout /t 3 /nobreak >nul
    nssm remove POSPrinterServer confirm >nul 2>&1
    timeout /t 2 /nobreak >nul
)

nssm install POSPrinterServer "%TARGET_DIR%\printer-server.exe"
nssm set POSPrinterServer AppDirectory "%TARGET_DIR%"
nssm set POSPrinterServer Start SERVICE_AUTO_START
nssm set POSPrinterServer DisplayName "POS Printer Server"
nssm set POSPrinterServer Description "POS Printer Server — WebSocket server for thermal/USB label and receipt printing"
nssm set POSPrinterServer AppStdout "%TARGET_DIR%\logs\stdout.log"
nssm set POSPrinterServer AppStderr "%TARGET_DIR%\logs\stderr.log"

:: Set NODE_PATH so native modules can be found
nssm set POSPrinterServer AppEnvironmentExtra NODE_PATH=%TARGET_DIR%\node_modules

echo   Service installed

echo [8/8] Starting Service...
nssm start POSPrinterServer
if %errorlevel% equ 0 (
    echo   Service started successfully
) else (
    echo   WARNING: Service may already be running
)

:: ---- Write version.json ----
set "VERSION_FILE=%TARGET_DIR%\version.json"
copy /Y "%SCRIPT_DIR%version.json" "%VERSION_FILE%" >nul 2>&1

:: Read version from our version file for display, then update installedAt
for /f "tokens=2 delims=:, " %%a in ('findstr "version" "%VERSION_FILE%"') do set PKG_VERSION=%%~a
set PKG_VERSION=%PKG_VERSION:"=%

:: Write proper version.json with installedAt
echo { > "%VERSION_FILE%"
echo   "version": "%PKG_VERSION%", >> "%VERSION_FILE%"
echo   "buildDate": "%DATE%", >> "%VERSION_FILE%"
echo   "name": "POS Printer Server", >> "%VERSION_FILE%"
echo   "installPath": "%TARGET_DIR%", >> "%VERSION_FILE%"
echo   "installedAt": "%DATE% %TIME%" >> "%VERSION_FILE%"
echo } >> "%VERSION_FILE%"

:: ---- Add Firewall Rule ----
echo.
echo Adding Windows Firewall rule...
netsh advfirewall firewall add rule name="POSPrinterServer" dir=in action=allow protocol=TCP localport=8080 >nul 2>&1
if %errorlevel% equ 0 (
    echo   Firewall rule added for port 8080
) else (
    echo   Firewall rule may already exist
)

echo.
echo ============================================
echo  Installation Complete!
echo ============================================
echo.
echo  Location: %TARGET_DIR%
echo  Service:  POSPrinterServer (auto-start)
echo  Port:     8080
echo  Version:  %PKG_VERSION%
echo.
echo  The printer server is now running.
echo  You can close this window.
echo.
echo ============================================

timeout /t 5 /nobreak >nul
