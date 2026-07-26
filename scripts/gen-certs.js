/**
 * gen-certs.js
 * Generate self-signed SSL certificates with Subject Alternative Names (SAN)
 * for localhost and 127.0.0.1.
 *
 * Requires: OpenSSL in PATH (or Git Bash / WSL)
 *
 * Usage: node scripts/gen-certs.js
 *        pnpm gen-certs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CERTS_DIR = path.resolve(__dirname, "..", "certs");
const KEY_FILE = path.join(CERTS_DIR, "localhost+2-key.pem");
const CERT_FILE = path.join(CERTS_DIR, "localhost+2.pem");

// OpenSSL config inline — defines a self-signed CA with SAN
const OPENSSL_CONFIG = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = localhost

[v3_req]
keyUsage = keyEncipherment, dataEncipherment, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`;

function findOpenSSL() {
  // Common locations on Windows
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
    "C:\\Program Files\\OpenSSL-Win32\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe",
  ];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} version`, { stdio: "pipe" });
      return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

function main() {
  // Ensure certs directory exists
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  const openssl = findOpenSSL();
  if (!openssl) {
    console.error(
      "❌ OpenSSL not found. Install it via:\n" +
        "   - Git for Windows (includes OpenSSL in Git Bash)\n" +
        "   - Or: choco install openssl\n" +
        "   - Or: winget install OpenSSL.OpenSSL"
    );
    process.exit(1);
  }

  console.log(`🔑 Using OpenSSL: ${openssl}`);

  // Write config to temp file
  const configPath = path.join(CERTS_DIR, "openssl-san.cnf");
  fs.writeFileSync(configPath, OPENSSL_CONFIG, "utf8");

  try {
    // Remove old certs
    for (const f of [KEY_FILE, CERT_FILE]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    const cmd = [
      `"${openssl}"`,
      "req -x509 -newkey rsa:2048",
      `-keyout "${KEY_FILE}"`,
      `-out "${CERT_FILE}"`,
      `-config "${configPath}"`,
      "-days 3650 -nodes",
    ].join(" ");

    execSync(cmd, { stdio: "inherit" });

    console.log("");
    console.log("✅ Certificates generated:");
    console.log(`   Key:  ${KEY_FILE}`);
    console.log(`   Cert: ${CERT_FILE}`);
    console.log("");
    console.log("🔍 Verifying SAN entries...");
    execSync(`"${openssl}" x509 -in "${CERT_FILE}" -text -noout | findstr "Subject Alternative Name"`, {
      stdio: "inherit",
    });
  } finally {
    // Clean up temp config
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  }
}

main();
