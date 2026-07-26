param(
    [string]$Version = "",
    [string]$BuildDate = (Get-Date -Format "yyyy-MM-dd"),
    [string]$AppName = "POS Printer Server"
)

# Auto-detect version from package.json if not specified
if ([string]::IsNullOrEmpty($Version)) {
    $pj = Join-Path $PSScriptRoot "package.json"
    if (Test-Path $pj) {
        try {
            $pkg = Get-Content $pj -Raw | ConvertFrom-Json
            if ($pkg.version) { $Version = $pkg.version }
        } catch { }
    }
    if ([string]::IsNullOrEmpty($Version)) { $Version = "1.0.0" }
}

$ErrorActionPreference = "Continue"  # we check for failures explicitly after each step
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

# ---- Step 3: Build production node_modules ----
Write-Host "[3/5] Building production node_modules..."

$TEMP_NM_DIR = Join-Path $PKG_DIR "temp-nm"
if (Test-Path $TEMP_NM_DIR) { Remove-Item -Recurse -Force $TEMP_NM_DIR }
$null = New-Item -ItemType Directory -Force -Path $TEMP_NM_DIR

# Copy package.json and use npm install --production for a flat dependency tree
Copy-Item (Join-Path $ROOT "package.json") (Join-Path $TEMP_NM_DIR "package.json")
Push-Location $TEMP_NM_DIR
try {
    # Install with --omit=dev so we only get runtime deps (no devDependencies)
    # Use --no-package-lock to avoid lockfile conflicts with pnpm.
    # Run via cmd.exe to avoid PowerShell stderr wrapping issues with npm warnings.
    cmd /c "npm install --omit=dev --ignore-scripts --no-package-lock --loglevel=error" 2>$null
    Write-Host "  ✅ npm install complete"
} finally {
    Pop-Location
}

# Copy the resulting node_modules to the bundle
$BUNDLE_NM_DIR = Join-Path $BUNDLE_DIR "node_modules"
if (Test-Path $BUNDLE_NM_DIR) { Remove-Item -Recurse -Force $BUNDLE_NM_DIR }
Move-Item (Join-Path $TEMP_NM_DIR "node_modules") $BUNDLE_NM_DIR
Remove-Item -Recurse -Force $TEMP_NM_DIR

# Ensure sharp's native binary + vendor libs are present (npm install with --ignore-scripts skips them)
$SHARP_PKG_DIR = Join-Path $BUNDLE_NM_DIR "sharp"
if (Test-Path $SHARP_PKG_DIR) {
    # Copy native .node binary + DLLs from pnpm store's build/Release
    # (npm install --ignore-scripts skips sharp's dll-copy step)
    $sharpPnpmBuild = Join-Path $PNPM_STORE "sharp@0.32.6\node_modules\sharp\build\Release"
    $sharpBuildDir = Join-Path $SHARP_PKG_DIR "build\Release"
    if (Test-Path $sharpPnpmBuild) {
        if (-not (Test-Path $sharpBuildDir)) {
            $null = New-Item -ItemType Directory -Force -Path $sharpBuildDir
        }
        # Copy all files from pnpm build/Release (.node + .dll)
        Copy-Item "$sharpPnpmBuild\*" $sharpBuildDir
        Write-Host "  ✅ sharp native binary + DLLs ($([math]::Round((Get-ChildItem $sharpBuildDir | Measure-Object -Property Length -Sum).Sum/1KB,0)) KB)"
    }

    # Copy vendor libs (libvips cached downloads)
    $sharpVendorDir = Join-Path $PNPM_STORE "sharp@0.32.6\node_modules\sharp\vendor"
    $vendorDest = Join-Path $SHARP_PKG_DIR "vendor"
    if (Test-Path $sharpVendorDir) {
        if (-not (Test-Path $vendorDest)) { $null = New-Item -ItemType Directory -Force -Path $vendorDest }
        Copy-Item -Recurse "$sharpVendorDir\*" $vendorDest
        Write-Host "  ✅ sharp vendor libs"
    }
}

# Copy usb native .node binary
$USB_PKG_DIR = Join-Path $BUNDLE_NM_DIR "usb"
if (Test-Path $USB_PKG_DIR) {
    $usbBuildDir = Join-Path $USB_PKG_DIR "prebuilds\win32-x64"
    if (-not (Test-Path $usbBuildDir)) { $null = New-Item -ItemType Directory -Force -Path $usbBuildDir }
    $usbNode = Join-Path $PNPM_STORE "usb@1.9.2\node_modules\usb\prebuilds\win32-x64\node.napi.node"
    if (Test-Path $usbNode) {
        Copy-Item $usbNode (Join-Path $usbBuildDir "node.napi.node")
        Write-Host "  ✅ usb native .node binary"
    }
}

$nmSize = (Get-ChildItem $BUNDLE_NM_DIR -Recurse | Measure-Object -Property Length -Sum).Sum
Write-Host "  node_modules total: $([math]::Round($nmSize/1MB,1)) MB"

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
Write-Host "  - node_modules/       (native .node + JS wrappers for sharp, usb, escpos-usb)"
Write-Host "  - certs/              (SSL certificates)"
Write-Host "  - images/             (logos)"
Write-Host "  - setup.bat           (right-click → Run as Administrator)"
Write-Host "  - update-service.bat  (for future updates)"
Write-Host "  - version.json        (version metadata)"
Write-Host ""
Write-Host "To install: extract zip → right-click setup.bat → Run as Administrator"
