const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

console.log("\n\u{1F4E6} Postbuild: setting up production node_modules in dist/...\n");

// ── 1. Read production deps with exact installed versions ──
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
);
const deps = {};
const depNames = Object.keys(rootPkg.dependencies || {});

for (const name of depNames) {
  try {
    const pkgPath = require.resolve(path.join(name, "package.json"), {
      paths: [ROOT],
    });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    deps[name] = pkg.version;
    console.log(`  ✔ ${name}@${pkg.version}`);
  } catch (e) {
    console.warn(`  ⚠ ${name}: could not resolve — ${e.message}`);
  }
}

// ── 2. Write temporary package.json in dist/ ──
const tmpPkg = { private: true, dependencies: deps };
const tmpPkgPath = path.join(DIST, "package.json");
fs.writeFileSync(tmpPkgPath, JSON.stringify(tmpPkg, null, 2));

// ── 3. Install production deps via npm (creates a flat node_modules) ──
console.log("\n  Installing production dependencies…");
const npmArgs = [
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
  "--prefer-online",
  "--loglevel=error",
].join(" ");
execSync(`npm ${npmArgs}`, { cwd: DIST, stdio: "inherit" });

// ── 4. Copy native binaries that --ignore-scripts skipped ──
const nmDist = path.join(DIST, "node_modules");
let nativeCount = 0;

function copyNative(name, version, subpath) {
  const destDir = path.join(nmDist, name);
  if (!fs.existsSync(destDir)) return false;

  const storeName = name.startsWith("@") ? name.replace("/", "+") : name;
  const storePath = path.join(
    ROOT,
    "node_modules",
    ".pnpm",
    `${storeName}@${version}`,
    "node_modules",
    name,
    subpath
  );

  if (!fs.existsSync(storePath)) return false;

  const dest = path.join(destDir, subpath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    fs.cpSync(storePath, dest, { recursive: true, dereference: true });
    return true;
  } catch (e) {
    console.warn(`  ⚠ failed to copy ${name}/${subpath}: ${e.message}`);
    return false;
  }
}

// sharp: native .node + DLLs in build/Release/, libvips in vendor/
if (deps["sharp"]) {
  if (copyNative("sharp", deps["sharp"], "build/Release")) {
    console.log("  ✅ sharp native .node + DLLs");
    nativeCount++;
  }
  if (copyNative("sharp", deps["sharp"], "vendor")) {
    console.log("  ✅ sharp vendor libs");
    nativeCount++;
  }
}

// usb: native .node in prebuilds/
if (deps["usb"]) {
  if (copyNative("usb", deps["usb"], "prebuilds")) {
    console.log("  ✅ usb native .node");
    nativeCount++;
  }
}

if (nativeCount === 0) {
  console.warn(
    "  ⚠ No native binaries copied (check that packages are installed)"
  );
}

// @img native packages: copy so they are available if needed
for (const imgDep of ["@img/sharp-win32-x64", "@img/sharp-libvips-win32-x64"]) {
  if (deps[imgDep]) {
    const storeName = imgDep.replace("/", "+");
    const storeBase = path.join(
      ROOT,
      "node_modules",
      ".pnpm",
      `${storeName}@${deps[imgDep]}`,
      "node_modules",
      imgDep
    );
    const destBase = path.join(nmDist, imgDep);
    if (fs.existsSync(storeBase) && !fs.existsSync(destBase)) {
      fs.mkdirSync(path.dirname(destBase), { recursive: true });
      try {
        fs.cpSync(storeBase, destBase, {
          recursive: true,
          dereference: true,
        });
        console.log(`  ✅ ${imgDep}`);
        nativeCount++;
      } catch (e) {
        console.warn(`  ⚠ failed to copy ${imgDep}: ${e.message}`);
      }
    }
  }
}

// ── 5. Copy runtime asset directories (certs, images, version.json) ──
function copyAssetDir(srcDir, destDir) {
  const src = path.join(ROOT, srcDir);
  const dest = path.join(DIST, destDir || srcDir);
  if (fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    try {
      fs.cpSync(src, dest, { recursive: true, dereference: true });
      console.log(`  ✅ ${srcDir}/`);
    } catch (e) {
      console.warn(`  ⚠ failed to copy ${srcDir}/: ${e.message}`);
    }
  } else {
    console.warn(`  ⚠ ${srcDir}/ not found — skipping`);
  }
}

copyAssetDir("certs");
copyAssetDir("images");

const versionJson = path.join(ROOT, "version.json");
const versionDest = path.join(DIST, "version.json");
if (fs.existsSync(versionJson)) {
  fs.cpSync(versionJson, versionDest, { dereference: true });
  console.log("  ✅ version.json");
}

// ── 7. Remove leftover npm artifacts ──
for (const f of [".package-lock.json", "package-lock.json"]) {
  const fp = path.join(DIST, f);
  if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (_) {}
}

console.log(`\n✅ Postbuild complete — dist/node_modules/ ready`);
console.log(`   ${nativeCount} native package(s) copied`);
console.log(`   dist/printer-server.exe — run it directly\n`);
