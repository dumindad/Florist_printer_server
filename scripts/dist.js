/**
 * Distribution packer for printer-server.
 *
 * Native modules (sharp, usb, escpos-usb) cannot be bundled into a single .exe
 * via pkg. This script creates a portable folder with everything needed:
 *   - All JS source files
 *   - node_modules (pruned to production)
 *   - A start.bat launcher
 *   - Node.js runtime download instructions
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..';
const DIST = path.join(ROOT, 'dist');

console.log('Creating portable distribution...');

// Ensure dist exists
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// 1. Copy source files
const srcFiles = ['print.js', 'labelPrint.js', 'POSprinter.js', 'package.json', 'version.json'];
const srcDirs = ['images'];

for (const f of srcFiles) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, f));
    console.log(`  Copied ${f}`);
  }
}

for (const d of srcDirs) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src)) {
    execSync(`xcopy "${src}" "${path.join(DIST, d)}\\" /E /I /Y /Q`, { stdio: 'ignore' });
    console.log(`  Copied ${d}/`);
  }
}

// 2. Prune & copy node_modules (production only)
console.log('  Pruning dev dependencies...');
execSync('npm prune --production', { cwd: ROOT, stdio: 'ignore' });

console.log('  Copying node_modules...');
execSync(`xcopy "${path.join(ROOT, 'node_modules')}" "${path.join(DIST, 'node_modules')}\\" /E /I /Y /Q`, { stdio: 'ignore' });

// 3. Create start.bat
const startBat = `@echo off
echo Starting POS Printer Server...
echo.
echo If Node.js is not installed, download from: https://nodejs.org/
echo.
node "%~dp0print.js"
if %errorlevel% neq 0 (
  echo.
  echo ERROR: Node.js not found or script failed.
  echo Download Node.js from https://nodejs.org/ and try again.
  pause
)
`;
fs.writeFileSync(path.join(DIST, 'start.bat'), startBat, 'utf8');
console.log('  Created start.bat');

// 4. Create install-service.bat (optional Windows service)
const installBat = `@echo off
echo Installing POS Printer Server as Windows service...
echo.
echo This requires Administrator privileges.
echo.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Please run as Administrator.
  pause
  exit /b 1
)
node "%~dp0POSprinter.js"
echo.
echo Service installed. Check Services.msc for "POSprinter".
pause
`;
fs.writeFileSync(path.join(DIST, 'install-service.bat'), installBat, 'utf8');
console.log('  Created install-service.bat');

// 5. Restore dev dependencies
console.log('  Restoring dev dependencies...');
execSync('npm install', { cwd: ROOT, stdio: 'ignore' });

console.log('\n✅ Distribution created at: ' + DIST);
console.log(`   Size: ${(getDirSize(DIST) / 1024 / 1024).toFixed(1)} MB`);
console.log('\nTo deploy:');
console.log('  1. Copy the "dist" folder to the target machine');
console.log('  2. Install Node.js from https://nodejs.org/ (if not installed)');
console.log('  3. Double-click start.bat');
console.log('  4. Server starts on ws://localhost:8080');

function getDirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) size += fs.statSync(full).size;
    else if (entry.isDirectory()) size += getDirSize(full);
  }
  return size;
}
