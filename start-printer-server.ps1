# start-printer-server.ps1
# Start the POS printer server (ws://localhost:8080)
# Run this at startup or manually when the server is needed.
#
# To auto-start on login:
#   1. Open Task Scheduler
#   2. Create Basic Task → "POS Printer Server"
#   3. Trigger: "When the computer starts" or "When I log on"
#   4. Action: Start a program → "powershell.exe"
#      Arguments: "-WindowStyle Hidden -ExecutionPolicy Bypass -File D:\projects\printer_server\start-printer-server.ps1"
#
# To start manually:
#   powershell -ExecutionPolicy Bypass -File D:\projects\printer_server\start-printer-server.ps1

$logFile = "D:\projects\printer_server\server.log"
$pidFile = "D:\projects\printer_server\server.pid"
$serverDir = "D:\projects\printer_server"

# Check if already running
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile
    $running = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "Printer server already running (PID $oldPid)"
        exit 0
    }
}

# Start the server
$process = Start-Process -NoNewWindow -PassThru -FilePath "node" `
    -ArgumentList "print.js" `
    -WorkingDirectory $serverDir

# Save PID for future checks
$process.Id | Out-File -FilePath $pidFile -Encoding utf8

# Also add to startup via registry for current user
$startupPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupName = "POSPrinterServer"
$startupValue = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serverDir\start-printer-server.ps1`""

try {
    Set-ItemProperty -Path $startupPath -Name $startupName -Value $startupValue -ErrorAction SilentlyContinue
} catch {
    Write-Warning "Could not set startup registry (run as admin for all users)"
}

Write-Host "Printer server started (PID $($process.Id))"
"$(Get-Date) - Started server (PID $($process.Id))" | Out-File -Append -FilePath $logFile -Encoding utf8
