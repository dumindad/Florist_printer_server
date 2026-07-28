@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  POS Printer Server - Update
echo ============================================
echo.

set "TARGET_DIR=C:\POSPrinterServer"
set "BACKUP_DIR=%TARGET_DIR%\backups"
set "REPO=dumindad/Florist_printer_server"
set "API_URL=https://api.github.com/repos/%REPO%/releases/latest"
set "DOWNLOAD_DIR=%TEMP%\pos-printer-update"
set "EXE_URL="

REM ---- Check if running as admin (required for service control) ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Right-click update-service.bat and select "Run as Administrator"
    pause
    exit /b 1
)

REM ---- Step 1: Check local update file first ----
if exist "%TARGET_DIR%\printer-server-new.exe" (
    echo [Quick] Found printer-server-new.exe — using local file.
    set "LOCAL_UPDATE=1"
    goto :INSTALL
)

REM ---- Step 2: Fetch latest release from GitHub ----
echo [1/5] Checking for updates from GitHub...

REM Try to get printer-server.exe asset URL; fallback to zip
for /f "usebackq delims=" %%a in (
    `powershell -NoProfile -Command ^
        "$r = Invoke-RestMethod -Uri '%API_URL%' -UseBasicParsing; ^
         $exe = $r.assets | Where-Object { $_.name -eq 'printer-server.exe' }; ^
         if ($exe) { Write-Output $exe.browser_download_url; exit }; ^
         $zip = $r.assets | Where-Object { $_.name -like '*-v*.zip' } | Select-Object -First 1; ^
         if ($zip) { Write-Output 'ZIP:' + $zip.browser_download_url } else { Write-Output '' }"`
) do set "EXE_URL=%%a"

if "%EXE_URL%"=="" (
    echo   ERROR: Could not find printer-server.exe or zip in the latest release.
    pause
    exit /b 1
)

REM ---- Step 3: Download ----
echo [2/5] Downloading new version...
if exist "%DOWNLOAD_DIR%" rmdir /s /q "%DOWNLOAD_DIR%"
mkdir "%DOWNLOAD_DIR%" >nul 2>&1

set "IS_ZIP=0"
if "%EXE_URL:~0,4%"=="ZIP:" (
    set "IS_ZIP=1"
    set "EXE_URL=%EXE_URL:~4%"
)

if "%IS_ZIP%"=="1" (
    echo   Downloading release zip...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%EXE_URL%' -OutFile '%DOWNLOAD_DIR%\release.zip' -UseBasicParsing; Write-Output 'OK' } catch { Write-Output 'FAILED' }" > "%DOWNLOAD_DIR%\dl_result.txt"
    set /p DL_RESULT=<"%DOWNLOAD_DIR%\dl_result.txt"
    if not "!DL_RESULT!"=="OK" ( echo   ERROR: Download failed. & pause & exit /b 1 )
    echo   Extracting printer-server.exe...
    powershell -NoProfile -Command "try { Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [System.IO.Compression.ZipFile]::OpenRead('%DOWNLOAD_DIR%\release.zip'); $e = $z.Entries | Where-Object { $_.Name -eq 'printer-server.exe' } | Select-Object -First 1; if ($e) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '%DOWNLOAD_DIR%\printer-server.exe', $true); Write-Output 'OK' } else { Write-Output 'NOT_FOUND' }; $z.Dispose() } catch { Write-Output 'FAILED' }" > "%DOWNLOAD_DIR%\extract_result.txt"
    set /p EX_RESULT=<"%DOWNLOAD_DIR%\extract_result.txt"
    if not "!EX_RESULT!"=="OK" ( echo   ERROR: Failed to extract exe from zip. & pause & exit /b 1 )
) else (
    echo   Downloading printer-server.exe...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%EXE_URL%' -OutFile '%DOWNLOAD_DIR%\printer-server.exe' -UseBasicParsing; Write-Output 'OK' } catch { Write-Output 'FAILED' }" > "%DOWNLOAD_DIR%\dl_result.txt"
    set /p DL_RESULT=<"%DOWNLOAD_DIR%\dl_result.txt"
    if not "!DL_RESULT!"=="OK" ( echo   ERROR: Download failed. & pause & exit /b 1 )
)

REM Verify file
if not exist "%DOWNLOAD_DIR%\printer-server.exe" (
    echo   ERROR: Downloaded file not found.
    pause
    exit /b 1
)

set /a EXE_SIZE=0
for %%f in ("%DOWNLOAD_DIR%\printer-server.exe") do set EXE_SIZE=%%~zf
if !EXE_SIZE! LSS 1000000 (
    echo   ERROR: Downloaded file is too small (!EXE_SIZE! bytes) — may be invalid.
    pause
    exit /b 1
)

echo   Downloaded !EXE_SIZE! bytes

:INSTALL

REM ---- Step 4: Stop service ----
echo [3/5] Stopping service...
nssm stop POSPrinterServer
if %errorlevel% neq 0 (
    echo   WARNING: Could not stop service (may already be stopped)
)
timeout /t 3 /nobreak >nul

REM ---- Step 5: Backup and replace ----
echo [4/5] Installing new version...
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%" >nul 2>&1

REM Backup old exe with timestamp
if exist "%TARGET_DIR%\printer-server.exe" (
    for /f "tokens=2 delims==" %%i in ('wmic os get localdatetime /value') do set DT=%%i
    set "TS=!DT:~0,8!_!DT:~8,6!"
    move "%TARGET_DIR%\printer-server.exe" "%BACKUP_DIR%\printer-server-v!TS!.exe" >nul 2>&1
    echo   Old version backed up to backups\printer-server-v!TS!.exe
)

REM Copy from local update or from download
if defined LOCAL_UPDATE (
    copy "%TARGET_DIR%\printer-server-new.exe" "%TARGET_DIR%\printer-server.exe" >nul 2>&1
    del "%TARGET_DIR%\printer-server-new.exe" >nul 2>&1
) else (
    copy "%DOWNLOAD_DIR%\printer-server.exe" "%TARGET_DIR%\printer-server.exe" >nul 2>&1
)

if %errorlevel% neq 0 (
    echo   ERROR: Failed to copy new version.
    pause
    exit /b 1
)

REM Clean up
if exist "%DOWNLOAD_DIR%" rmdir /s /q "%DOWNLOAD_DIR%" >nul 2>&1

echo   New version installed.

REM ---- Step 6: Start service ----
echo [5/5] Starting service...
nssm start POSPrinterServer
if %errorlevel% equ 0 (
    echo.
    echo ============================================
    echo  Update Complete!
    echo ============================================
    echo   New version started successfully.
) else (
    echo   WARNING: Service may not have started. Check manually.
    echo   Try: nssm start POSPrinterServer
)

echo.
pause
