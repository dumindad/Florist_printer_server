@echo off
title POS Printer Server
echo =====================================
echo   POS Printer Server
echo   ws://localhost:8080
echo =====================================
echo.
node "%~dp0print.js"
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Node.js not found or script failed.
    echo Download Node.js from https://nodejs.org/
    pause
)
