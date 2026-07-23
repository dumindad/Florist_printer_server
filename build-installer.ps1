param(
    [string]$Version = "1.0.0",
    [string]$BuildDate = (Get-Date -Format "yyyy-MM-dd"),
    [string]$AppName = "POS Printer Server"
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$DIST = Join-Path $ROOT "dist"
$NODE_MODULES = Join-Path $ROOT "node_modules"
$PNPM_STORE = Join-Path $NODE_MODULES ".pnpm"

Write-Host "============================================"
Write-Host " $AppName - Installer Builder v$Version"
Write-Host "============================================"
Write-Host ""

# ---- Step 1: Build the .exe ----
Write-Host "[1/5] Compiling printer-server.exe..."
Push-Location $ROOT
try {
    # Ensure certs exist
    if (-not (Test-Path (Join-Path $ROOT "certs\localhost+2.pem"))) {
        throw "SSL certs not found in certs/. Run openssl to generate them first."
    }

    pnpm build
    if (-not (Test-Path (Join-Path $DIST "printer-server.exe"))) {
        throw "Build failed: printer-server.exe not found in dist/"
    }
    Write-Host "  ✅ printer-server.exe ($([math]::Round((Get-Item (Join-Path $DIST 'printer-server.exe')).Length/1MB,1)) MB)"
} finally {
    Pop-Location
}

# ---- Step 2: Create package directory ----
Write-Host "[2/5] Creating package structure..."
$PKG_DIR = Join-Path $DIST "installer"
if (Test-Path $PKG_DIR) { Remove-Item -Recurse -Force $PKG_DIR }
$null = New-Item -ItemType Directory -Force -Path $PKG_DIR

$BUNDLE_DIR = Join-Path $PKG_DIR "pos-printer-server"
$null = New-Item -ItemType Directory -Force -Path $BUNDLE_DIR
$NATIVE_DIR = Join-Path $BUNDLE_DIR "native_modules"
$null = New-Item -ItemType Directory -Force -Path $NATIVE_DIR

# ---- Step 3: Copy native modules ----
Write-Host "[3/5] Copying native modules..."

# Sharp .node
$sharpNode = Join-Path $PNPM_STORE "sharp@0.32.6\node_modules\sharp\build\Release\sharp-win32-x64.node"
$sharpVendorDir = Join-Path $PNPM_STORE "sharp@0.32.6\node_modules\sharp\vendor"
if (Test-Path $sharpNode) {
    Copy-Item $sharpNode (Join-Path $NATIVE_DIR "sharp-win32-x64.node")
    Write-Host "  ✅ sharp-win32-x64.node"
}
if (Test-Path $sharpVendorDir) {
    $vendorDest = Join-Path $NATIVE_DIR "sharp-vendor"
    Copy-Item -Recurse $sharpVendorDir $vendorDest
    $vendorSize = (Get-ChildItem $vendorDest -Recurse | Measure-Object -Property Length -Sum).Sum
    Write-Host "  ✅ sharp vendor libs ($([math]::Round($vendorSize/1KB,0)) KB)"
}

# @img/sharp-win32-x64 (newer sharp)
$imgSharpNode = Join-Path $PNPM_STORE "@img+sharp-win32-x64@0.34.5\node_modules\@img\sharp-win32-x64\lib\sharp-win32-x64.node"
if (Test-Path $imgSharpNode) {
    Copy-Item $imgSharpNode (Join-Path $NATIVE_DIR "sharp-win32-x64.img.node")
    Write-Host "  ✅ sharp-win32-x64 (img variant)"
}

# USB native (win32-x64 only)
$usbDir = Join-Path $PNPM_STORE "usb@1.9.2\node_modules\usb\prebuilds\win32-x64"
$usbNode = Join-Path $usbDir "node.napi.node"
if (Test-Path $usbNode) {
    $usbDest = Join-Path $NATIVE_DIR "usb"
    $null = New-Item -ItemType Directory -Force -Path $usbDest
    Copy-Item $usbNode (Join-Path $usbDest "node.napi.node")
    Write-Host "  ✅ usb (win32-x64)"
}

# ---- Step 4: Download nssm ----
Write-Host "[4/5] Downloading nssm..."
$nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$nssmZip = Join-Path $PKG_DIR "nssm-2.24.zip"
try {
    Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing -ErrorAction Stop
    Expand-Archive -Path $nssmZip -DestinationPath (Join-Path $PKG_DIR "nssm") -Force
    $nssmExe = Get-ChildItem -Path (Join-Path $PKG_DIR "nssm") -Recurse -Filter "nssm.exe" | Select-Object -First 1
    if ($nssmExe) {
        Copy-Item $nssmExe.FullName (Join-Path $BUNDLE_DIR "nssm.exe")
        Remove-Item -Recurse -Force (Join-Path $PKG_DIR "nssm")
        Write-Host "  ✅ nssm.exe ($([math]::Round((Get-Item (Join-Path $BUNDLE_DIR 'nssm.exe')).Length/1KB,0)) KB)"
    }
} catch {
    Write-Host "  ⚠️  Could not download nssm from $nssmUrl"
    Write-Host "  Please manually download and place nssm.exe in the package."
}
if (Test-Path $nssmZip) { Remove-Item $nssmZip -Force }

# ---- Step 4b: Copy main exe and scripts ----
Write-Host "     Copying printer-server.exe..."
Copy-Item (Join-Path $DIST "printer-server.exe") (Join-Path $BUNDLE_DIR "printer-server.exe")

# Copy install/setup scripts
Copy-Item (Join-Path $ROOT "setup.bat") (Join-Path $BUNDLE_DIR "setup.bat")
if (Test-Path (Join-Path $ROOT "update-service.bat")) {
    Copy-Item (Join-Path $ROOT "update-service.bat") (Join-Path $BUNDLE_DIR "update-service.bat")
}

# Copy certs
$certsDest = Join-Path $BUNDLE_DIR "certs"
$null = New-Item -ItemType Directory -Force -Path $certsDest
Copy-Item (Join-Path $ROOT "certs\*.pem") $certsDest

# Copy images
$imagesDest = Join-Path $BUNDLE_DIR "images"
Copy-Item (Join-Path $ROOT "images") $imagesDest -Recurse

# Write version.json
$versionJson = @{
    version     = $Version
    buildDate   = $BuildDate
    name        = $AppName
    installedAt = "TBD"
} | ConvertTo-Json
$versionJson | Out-File -FilePath (Join-Path $BUNDLE_DIR "version.json") -Encoding utf8

# ---- Step 5: Package into ZIP ----
Write-Host "[5/5] Packaging installer..."
$zipPath = Join-Path $DIST "pos-printer-server-v$Version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($BUNDLE_DIR, $zipPath)

$zipSize = (Get-Item $zipPath).Length
Write-Host ""
Write-Host "============================================"
Write-Host "  Package Complete!"
Write-Host "  File:  $zipPath"
Write-Host "  Size:  $([math]::Round($zipSize/1MB, 1)) MB"
Write-Host "============================================"
Write-Host ""
Write-Host "Contents:"
Write-Host "  - printer-server.exe  (the compiled server)"
Write-Host "  - nssm.exe            (Windows Service manager)"
Write-Host "  - native_modules/     (.node files for sharp, usb)"
Write-Host "  - certs/              (SSL certificates)"
Write-Host "  - images/             (logos)"
Write-Host "  - setup.bat           (right-click → Run as Administrator)"
Write-Host "  - update-service.bat  (for future updates)"
Write-Host "  - version.json        (version metadata)"
Write-Host ""
Write-Host "To install: extract zip → right-click setup.bat → Run as Administrator"
