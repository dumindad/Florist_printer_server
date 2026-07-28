const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Version metadata (read from version.json) ──
let APP_VERSION = "1.0.0";
let BUILD_DATE = "unknown";
let APP_NAME = "POS Printer Server";
try {
  const versionPath = path.join(__dirname, "version.json");
  if (fs.existsSync(versionPath)) {
    const v = JSON.parse(fs.readFileSync(versionPath, "utf8"));
    APP_VERSION = v.version || APP_VERSION;
    BUILD_DATE = v.buildDate || BUILD_DATE;
    APP_NAME = v.name || APP_NAME;
  }
} catch (e) { /* ignore */ }

// ── Helper: resolve asset paths (works in dev + pkg) ──
function getAssetPath(filePath) {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), filePath);
  }
  return path.join(__dirname, filePath);
}

// ── When running inside a packaged executable ──
if (process.pkg) {
  const basePath = path.dirname(process.execPath);
  const nodeModulesPath = path.join(basePath, "node_modules");
  process.env.NODE_PATH = nodeModulesPath;
  require("module").Module._initPaths();
  process.env.SHARP_PATH = path.join(nodeModulesPath, "sharp");
}

// ── Load modules (pkg-aware) ──
const WebSocket = require("ws");
const escpos = require("escpos");

const sharp = process.pkg
  ? require(path.join(process.env.NODE_PATH, "sharp"))
  : require("sharp");

const usb = process.pkg
  ? require(path.join(process.env.NODE_PATH, "usb"))
  : require("usb");

escpos.USB = process.pkg
  ? require(path.join(process.env.NODE_PATH, "escpos-usb"))
  : require("escpos-usb");

// ── SSL certs ──
const certPath = getAssetPath("certs/localhost+2.pem");
const keyPath = getAssetPath("certs/localhost+2-key.pem");

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error("❌ SSL cert files not found at:", certPath);
  console.error("   Generate them with: openssl req -x509 -newkey rsa:2048 -keyout localhost+2-key.pem -out localhost+2.pem -days 3650 -nodes -subj '/CN=localhost'");
  process.exit(1);
}

// ── HTTPS server (health/version + WebSocket) ──
const server = https.createServer(
  {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  },
  (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/version" || req.url === "/api/version") {
      const data = JSON.stringify({
        version: APP_VERSION,
        buildDate: BUILD_DATE,
        name: APP_NAME,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: process.uptime(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
      return;
    }

    if (req.url === "/health" || req.url === "/api/health") {
      const data = JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        wsClients: wss ? wss.clients.size : 0,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
      return;
    }

    res.writeHead(200);
    res.end("POS Printer Server — WSS on wss://localhost:8080");
  },
);

// ── WebSocket on top of HTTPS (WSS) ──
const wss = new WebSocket.Server({ server });

let printQueue = [];
let labelPrintQueue = [];
let isPrinting = false;
let isLabelPrinting = false;

// ── Printer mode tracking (hybrid: USB detection + remembered-mode fallback) ──
let lastKnownMode = null;        // "ESC" | "TSPL" — last mode the user confirmed
let pendingModeChange = null;    // { ws, neededMode, printJob } — paused waiting for MODE_READY

wss.on("connection", (ws) => {
  console.log("Client connected");
  console.log("printQueue", printQueue);
  console.log("labelPrintQueue", labelPrintQueue);

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      console.log("Received message:", data);

      if (data.type === "PRINT") {
        queuePrintJob(data, ws);
      } else if (data.type === "PRINT_PACKAGE_PRODUCTS") {
        queuePrintJobToMakeB(data, ws);
      } else if (data.type === "PRINT_LABEL_CODE") {
        queuePrintLabelJob(data, ws);
      } else if (data.type === "MODE_READY") {
        handleModeReady(ws);
      } else if (data.type === "MODE_SET") {
        // User tells us the current mode of the printer (for remembered-mode fallback)
        if (data.mode === 'ESC' || data.mode === 'TSPL') {
          lastKnownMode = data.mode;
          console.log(`👤 User set printer mode to: ${lastKnownMode}`);
          ws.send(JSON.stringify({ type: "MODE_SET_CONFIRMED", mode: lastKnownMode }));
        }
      }
    } catch (err) {
      console.error("Error:", err);
      ws.send(JSON.stringify({ success: false, error: err.message }));
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

// Start server on port 8080
server.listen(8080, "0.0.0.0", () => {
  console.log(`🚀 WSS server running on wss://localhost:8080`);
  console.log(`📡 Version: ${APP_VERSION}`);
  console.log(`📡 Build: ${BUILD_DATE}`);
});

// Function to queue the print job
function queuePrintJob(printJob, ws) {
    printQueue.push({ printJob, ws });
    processPrintQueue(); // Process the queue
}
// Function to queue the print job for package products
function queuePrintJobToMakeB(printJob, ws) {
    console.log("queuePrint----", printJob, isLabelPrinting)
    labelPrintQueue.push({ printJob, ws, isLabelPrinting: true });
    processLabelPrintQueue(); // Process the queue
}

// Function to queue label-code print jobs (TSPL mode)
function queuePrintLabelJob(printJob, ws) {
    // Use a single queue approach: processLabelPrintQueue already handles ESC/POS jobs
    // For TSPL label jobs, we handle them directly with mode check
    console.log("queuePrintLabelJob----", printJob)
    ensurePrinterMode('TSPL', ws).then((modeOK) => {
        if (!modeOK) {
            // Queue is paused — store job for later
            pendingModeChange = { ws, neededMode: 'TSPL', printJob };
            return;
        }
        printLabel(printJob, ws);
    });
}

// Function to process the print queue
async function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;
    // Don't start a new job if waiting for mode change confirmation
    if (pendingModeChange) return;

    isPrinting = true;
    const { printJob, ws } = printQueue.shift(); // Get the next job
    console.log("processPrintQueue", printJob)

    // Check printer mode before printing
    const modeOK = await ensurePrinterMode('ESC', ws);
    if (!modeOK) {
      // Queue is paused waiting for MODE_READY — put job back and release
      printQueue.unshift({ printJob, ws });
      isPrinting = false;
      return;
    }

    printReceipt(printJob)
        .then(() => {
            ws.send(JSON.stringify({ success: true }));
            isPrinting = false;
            processPrintQueue(); // Process next job
        })
        .catch((error) => {
            console.error("Print failed:", error);
            if (ws && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ success: false, error: error.message }));
            }
            printQueue.push({ printJob, ws }); // Requeue the failed job
            isPrinting = false;
            setTimeout(processPrintQueue, 5000); // Retry after 5 seconds
        });
}

// Process label print queue
async function processLabelPrintQueue() {
    if (isLabelPrinting || labelPrintQueue.length === 0) return;
    // Don't start a new job if waiting for mode change confirmation
    if (pendingModeChange) return;

    isLabelPrinting = true;
    const { printJob, ws } = labelPrintQueue.shift();
    console.log("lable how to", printJob)

    // Package products print in ESC/POS mode (uses escpos library)
    const modeOK = await ensurePrinterMode('ESC', ws);
    if (!modeOK) {
      // Queue is paused — put job back and release
      labelPrintQueue.unshift({ printJob, ws });
      isLabelPrinting = false;
      return;
    }

    printPackageLabel(printJob)
        .then(() => {
            ws.send(JSON.stringify({ success: true }));
            isLabelPrinting = false;
            processLabelPrintQueue();
        })
        .catch((error) => {
            console.error("Print failed:", error);
            ws.send(JSON.stringify({ success: false, error: error.message }));
            labelPrintQueue.push({ printJob, ws });
            isLabelPrinting = false;
            setTimeout(processLabelPrintQueue, 5000);
        });
}

// Function to print package product labels
async function printPackageLabel(data, ws) {
    return new Promise(async (resolve, reject) => {
        try {
            // Note: Printer must be in ESC/POS mode for package labels (checked before queue processing)

            const idVendor = parseInt(data.idVendor, 16); // Convert hex string to integer
            const idProduct = parseInt(data.idProduct, 16);
            const device = new escpos.USB(idVendor, idProduct);
            const printer = new escpos.Printer(device);

            device.open((error) => {
                if (error) {
                    return reject(new Error("Printer not connected or unavailable"));
                }
                console.log("print--", data.packageProducts.forEach((product) => { product.name, product.quantity }))
                data.packageProducts.forEach((product) => {
                    console.log("Name:", product.name, "Quantity:", product.quantity);
                });
                printer.align("CT")
                    .style("B")
                    .size(0, 0)
                    .text("Order Prep List")
                    .text("----------------------")
                    .align("LT")
                    .text(`Order ID: ${(data.invoiceNo).toString()}`)
                    .text(`Date: ${new Date(data.create).toLocaleString()}`)
                    .text("----------------------");

                data.packageProducts.forEach((product) => {
                    printer.text(`Product: ${product.name}`)
                        .text(`Quantity: ${product.quantity}`)
                        .text("Items:");
                    product.packagedItemList.forEach((item, index) => {
                        printer.text(`  ${index + 1}. ${item.name} - ${item.quantity} (${item.description2})`);
                    });
                    printer.text("----------------------");
                });

                printer
                    .text('')
                    .text('')
                    .cut()
                    .close();

                console.log("Print job sent successfully");
                if (ws && ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ success: true }));
                }
                resolve();
            });
        } catch (error) {
            console.error("Label printing failed:", error);
            if (ws && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ success: false, error: error.message }));
            }
            reject(error);
        }
    });
}


// Function to handle printing with error handling
async function printReceipt(data, ws) {
    return new Promise(async (resolve, reject) => {
        try {
            // Note: Printer must be in ESC/POS mode for receipts (checked before queue processing)

            const device = new escpos.USB(data.idVendor, data.idProduct);
            const printer = new escpos.Printer(device);
            const { invoiceNo, create, items, paymentMethod } = data;
            // Add before device.open:
            const logoPath = getAssetPath("images/logo.png");
            const processedLogo = getAssetPath("images/logo_processed.png");
            // Pre-process image first
            await sharp(logoPath)
                .resize(384, 384)
                .threshold()
                .toFile(processedLogo);

            device.open(function () {
                escpos.Image.load(processedLogo, (image) => {
                    printer.align('CT').image(image, 'd24')
                    // Store name and header
                    printer.style('b')
                        .size(1, 1)
                        .text('Marabedda Florist')
                        .size(0, 0)
                        .text(data.store_address)
                        .text(data.telphone)
                        // .style('normal')
                        .text('------------------------------------------------')
                        .align('LT')
                        .text(`Order ID: ${(invoiceNo).toString()}`)
                        .text(`Date: ${new Date(create).toLocaleString()}`)
                        .text('------------------------------------------------');

                    // Items
                    printer.tableCustom([
                        { text: 'Item', width: 0.1, align: 'LEFT' },
                        { text: 'Qty', width: 0.4, align: 'RIGHT' },
                        { text: 'Price Rs.', width: 0.2, align: 'RIGHT' },
                        { text: 'Total Rs.', width: 0.3, align: 'RIGHT' }
                    ]);

                    // ----------------------------------------------------------
                    // Print each item
                    items.forEach(item => {
                        const itemPrice = Number(item.price).toFixed(2);
                        const itemTotal = (Number(item.price) * item.quantity).toFixed(2);
                        // const currency = 'Rs.';

                        printer.tableCustom([
                            { text: item.name, width: 0.4, align: 'LEFT' },
                            { text: item.quantity.toString(), width: 0.1, align: 'RIGHT' },
                            { text: `${itemPrice}`, width: 0.2, align: 'RIGHT' },
                            { text: ` ${itemTotal} `, width: 0.3, align: 'RIGHT' }
                        ]);
                    });

                    // Totals
                    const currency = 'Rs.';
                    const subtotal = data.subtotal.toFixed(2);
                    const discount = data.discount;
                    const cashTendered = data.cashTendered.toFixed(2);
                    const cashBalance = data.cashBalance.toFixed(2);
                    const tax = (data.tax).toFixed(2);
                    const total = (data.total).toFixed(2);
                    const discout_symbol = "%";
                    const discountAmount = (data.discountAmount).toFixed(2);

                    printer.text('------------------------------------------------')
                        .align('RT')
                        .text(`Count: ${items.length}`)
                        .text(`Subtotal: ${currency} ${subtotal}`)
                    if (discount > 0) {
                        printer.text(`Discount: ${discout_symbol}${discount} ${currency}-${discountAmount}`);
                    }

                    if (tax > 0) {
                        printer.text(`Tax: ${currency} ${tax}`);
                    }

                    printer.style('b')
                        .text(`Total: ${currency} ${total}`)
                        .style('normal');

                        if (paymentMethod === 'cash') {
                            if (cashTendered > 0) {
                            printer.text(`Cash Tendered: ${currency} ${cashTendered}`)
                                .text(`Change: ${currency} ${cashBalance}`);
                        }
                    }

                    printer.text('------------------------------------------------')
                        .align('CT')
                        .text('Thank you for your purchase!')
                        .text('Come again soon!')
                        .text('')
                        .text('')
                        .cashdraw()
                        .cut()
                        .close();

                    console.log("Print job sent successfully");
                    if (ws && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ success: true }));
                    }
                    resolve();
                });
            });

        } catch (err) {
            console.error("Print failed:", err);
            if (ws && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ success: false, error: err.message }));
            }
            reject(err);
        }
    });

}


// Function to print package product labels Barcode and QR code

// Configuration
const VENDOR_ID = 0x0483;  // Verify these with USB device listing
const PRODUCT_ID = 0x5743; // Should match your Xprinter's actual IDs


function findPrinter(VID, PID) {
    return usb.getDeviceList().find(device =>
        device.deviceDescriptor.idVendor === VID &&
        device.deviceDescriptor.idProduct === PID
    );
}


// 1. Define sendRawCommand first
async function sendRawCommand(device, command) {
    return new Promise(async (resolve, reject) => {
        device.open();

        const iface = device.interfaces[0];

        try {
            // Only try to detach kernel driver on Linux/macOS
            if (os.platform() !== "win32" && iface.isKernelDriverActive()) {
                iface.detachKernelDriver();
            }
        } catch (err) {
            console.warn("Kernel driver check failed:", err.message);
        }

        iface.claim();

        const outEndpoint = iface.endpoints.find(ep => ep.direction === 'out');

        if (!outEndpoint) return reject("No output endpoint found");

        outEndpoint.transfer(Buffer.from(command), err => {
            iface.release(true, () => device.close());
            err ? reject(err) : resolve();
        });

    });
}

// ── Hybrid printer mode detection ──
// Tries USB detection first; returns 'ESC', 'TSPL', or null if detection fails.
async function queryPrinterMode() {
  const device = usb.findByIds(VENDOR_ID, PRODUCT_ID);
  if (!device) return null;

  try {
    device.open();
    const iface = device.interfaces[0];
    if (!iface) { device.close(); return null; }

    try {
      if (os.platform() !== "win32" && iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }
    } catch (_) {}

    iface.claim();

    // ── Approach A: Read from USB IN endpoint ──
    // Many thermal printers report status (incl. emulation mode) via interrupt IN endpoint
    const inEndpoint = iface.endpoints.find(ep => ep.direction === 'in');
    if (inEndpoint) {
      try {
        const statusBuf = await new Promise((resolve, reject) => {
          inEndpoint.transfer(8, (err, data) => {
            if (err) return reject(err);
            resolve(data);
          });
        });
        // Log raw status bytes for debugging
        console.log("📟 USB status bytes:", Array.from(statusBuf).map(b => b.toString(16).padStart(2, '0')).join(' '));

        // Some Xprinter models encode mode in status byte [0]:
        //   0x00 = ESC/POS (receipt), 0x01 = TSPL (label)
        // This is highly model-specific — adapt as needed for your printer
        const detected = statusBuf[0];
        if (detected === 0x01 || detected === 0x02) {
          iface.release(true, () => device.close());
          console.log(`🔍 USB detected printer mode: TSPL (status=0x${detected.toString(16)})`);
          return 'TSPL';
        } else if (detected === 0x00) {
          iface.release(true, () => device.close());
          console.log(`🔍 USB detected printer mode: ESC (status=0x${detected.toString(16)})`);
          return 'ESC';
        }
      } catch (e) {
        console.log("ℹ️ IN endpoint read not supported:", e.message);
      }
    }

    // ── Approach B: Try vendor-specific control transfer ──
    try {
      const ctrlBuf = Buffer.alloc(8);
      await new Promise((resolve, reject) => {
        // bmRequestType=0xC0 (vendor IN), bRequest=0x01, wValue=0, wIndex=0
        device.controlTransfer(0xC0, 0x01, 0x0000, 0x0000, ctrlBuf, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      console.log("📟 Control transfer response:", Array.from(ctrlBuf).map(b => b.toString(16)).join(' '));
      // If we got a meaningful response, interpret it here
    } catch (e) {
      console.log("ℹ️ Control transfer not supported:", e.message);
    }

    iface.release(true, () => device.close());
  } catch (e) {
    try { device.close(); } catch (_) {}
  }

  // Detection not supported by this printer model
  return null;
}

/**
 * Ensure printer is in the needed mode before printing.
 * Tries USB detection; falls back to last-known mode.
 * Returns true if mode is confirmed, false if user intervention needed.
 */
async function ensurePrinterMode(neededMode, ws) {
  // Step 1: Try USB detection
  try {
    const detected = await queryPrinterMode();
    if (detected === neededMode) {
      lastKnownMode = detected;
      console.log(`✅ Printer confirmed in ${detected} mode via USB detection`);
      return true; // No dialog needed
    }
    if (detected !== null) {
      // Detected a mode, but it's the wrong one — need user to switch
      console.log(`⚠️ Printer is in ${detected} mode, need ${neededMode}`);
      lastKnownMode = detected;
    }
  } catch (e) {
    console.log("ℹ️ USB mode detection failed:", e.message);
  }

  // Step 2: Fallback — check last-known mode
  if (lastKnownMode === neededMode) {
    console.log(`✅ Printer last known mode: ${lastKnownMode} — matches needed ${neededMode}`);
    return true;
  }

  // Step 3: Ask user to switch mode
  console.log(`🔄 Requesting mode change to ${neededMode} (last known: ${lastKnownMode})`);
  const neededModeLabel = neededMode === 'TSPL' ? 'label' : 'receipt';
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: "MODE_CHANGE_REQUIRED",
      neededMode: neededMode,
      paperRoll: neededModeLabel,
      message: `Set the printer to ${neededModeLabel.toUpperCase()} mode.`
    }));
  }

  // Pause queue — wait for MODE_READY
  pendingModeChange = { ws, neededMode };
  return false;
}

/** Resume queue after user confirms manual mode switch */
function handleModeReady(ws) {
  if (!pendingModeChange) {
    console.log("⚠️ Received MODE_READY but no pending mode change");
    return;
  }
  // Only accept MODE_READY from the same client that triggered the change
  if (pendingModeChange.ws !== ws) {
    console.log("⚠️ MODE_READY from different client — ignoring");
    return;
  }

  const mode = pendingModeChange.neededMode;
  const savedJob = pendingModeChange.printJob; // May hold a TSPL label job
  console.log(`✅ User confirmed mode switch to ${mode}`);
  lastKnownMode = mode;
  pendingModeChange = null;

  // If there's a saved label job, run it directly
  if (savedJob) {
    printLabel(savedJob, ws);
    return;
  }

  // Otherwise resume the paused queue
  processPrintQueue();
  processLabelPrintQueue();
}

async function setPrinterMode(targetMode) {
    console.log(`⏭️ setPrinterMode(${targetMode}) called — manual hardware procedure is required for this printer model.`);
    console.log(`   The mode switch is now handled via the MODE_CHANGE_REQUIRED → MODE_READY frontend flow.`);
    return true;
}


// async function printLabel(printData, ws) {


//     const printer = findPrinter(0x0483, 0x5743); // Replace with your printer's VID & PID
// // const withoutFirstWord = printData.price.split(' ').slice(1).join(' ');
// const priceString = printData.price;
// const words = priceString.trim().split(/\s+/); // Split by one or more spaces
// const withoutFirstWord = words.slice(1).join(' ');

//     console.log("price print", printData.price)
//     console.log("price withoutFirstWord", withoutFirstWord)
//     if (!printer) {
//         console.error("Printer not found");
//         process.exit(1);
//     }
//     // Label dimensions
//     const labelWidthMM = 30;
//     const labelHeightMM = 20;

//     const title = 'Marabedda' //printData.title;
//     const title2 = 'Florist'
//     const price = '4000.00' //printData.price;

//     // Calculate layout positions (in dots — 1mm ≈ 8 dots for most TSC printers)
//     // const dpi = 203;
//     // const mmToDots = mm => Math.round((dpi / 25.4) * mm); // 1 inch = 25.4mm

//     // const labelWidthDots = mmToDots(labelWidthMM); // ~240
//     // const centerX = labelWidthDots / 2;

//     // Center alignment offset (you can fine-tune these based on actual print results)
//     // const titleX = centerX - 4 * 8; // Approx 8 chars * 8 dots
//     // const priceX = centerX - 5 * 8;
//     const priceX = 65;

//     let barcodeCommand = '';
//     if (printData.barcodeType === 'QRCODE') {
//         // barcodeCommand = `QRCODE ${centerX - 100},20,L,4,A,0,"${printData.barcodeValue}"`;
//         barcodeCommand = `QRCODE 10,35,L,4,A,0,"${printData.barcodeValue}"`;
//     } else {
//         // Default to CODE128
//         // barcodeCommand = `BARCODE ${centerX - 100},30,"128",70,1,0,2,2,"${printData.barcodeValue}"`;
//         barcodeCommand = `BARCODE 10,50,"128",60,1,0,2,2,"${printData.barcodeValue}"`;
//     }

// const labelCommand = `
// SIZE 30 mm, 20 mm\r
// GAP 2 mm, 0\r
// DENSITY 8\r
// DIRECTION 1\r
// CLS\r
// TEXT 20,5,"3",0,1,1,"${title}"\r
// TEXT 120,30,"2",0,1,1,"${title2}"\r
// ${barcodeCommand}\r
// TEXT ${priceX},135,"2",0,1,1,"Rs.${withoutFirstWord}"
// PRINT ${printData.quantity},1\r
// `;
//     sendRawCommand(printer, labelCommand)
//         .then(() => console.log("Printed successfully"))
//         .catch(err => console.error("Print failed:", err));


// }


async function printLabel(printData, ws) {


    const printer = findPrinter(0x0483, 0x5743); // Replace with your printer's VID & PID
    // const withoutFirstWord = printData.price.split(' ').slice(1).join(' ');
    const priceString = printData.price;
    const words = priceString.trim().split(/\s+/); // Split by one or more spaces
    const withoutFirstWord = words.slice(1).join(' ');

    console.log("price print", printData.price)
    console.log("price withoutFirstWord", withoutFirstWord)
    if (!printer) {
        console.error("Printer not found");
        if (ws) ws.send(JSON.stringify({ success: false, error: "Printer not found" }));
        return;
    }

    // Note: Printer must be in TSPL mode for labels (checked before queue processing)

    // Label dimensions
    const labelWidthMM = 30;
    const labelHeightMM = 20;

    const title = 'Marabedda' //printData.title;
    const title2 = 'Florist'
    const price = '4000.00' //printData.price;

    // Calculate layout positions (in dots — 1mm ≈ 8 dots for most TSC printers)
    // const dpi = 203;
    // const mmToDots = mm => Math.round((dpi / 25.4) * mm); // 1 inch = 25.4mm

    // const labelWidthDots = mmToDots(labelWidthMM); // ~240
    // const centerX = labelWidthDots / 2;

    // Center alignment offset (you can fine-tune these based on actual print results)
    // const titleX = centerX - 4 * 8; // Approx 8 chars * 8 dots
    // const priceX = centerX - 5 * 8;
    const priceX = 65;

    let barcodeCommand = '';
    if (printData.barcodeType === 'QRCODE') {
        // barcodeCommand = `QRCODE ${centerX - 100},20,L,4,A,0,"${printData.barcodeValue}"`;
        barcodeCommand = `QRCODE 10,35,L,4,A,0,"${printData.barcodeValue}"`;
    } else {
        // Default to CODE128
        // barcodeCommand = `BARCODE ${centerX - 100},30,"128",70,1,0,2,2,"${printData.barcodeValue}"`;
        // barcodeCommand = `BARCODE 10,50,"128",60,1,0,2,2,"${printData.barcodeValue}"`;
        barcodeCommand = `BARCODE 10,30,"128",40,1,0,1,1,"${printData.barcodeValue}"`;

    }

    const labelCommand = `
SIZE 30 mm, 20 mm\r
GAP 2 mm, 0\r
DENSITY 8\r
DIRECTION 1\r
CLS\r
TEXT 20,5,"3",0,1,1,"${title}"\r
TEXT 120,30,"2",0,1,1,"${title2}"\r
${barcodeCommand}\r
TEXT ${priceX},135,"2",0,1,1,"Rs.${withoutFirstWord}"
PRINT ${printData.quantity},1\r
`;
    sendRawCommand(printer, labelCommand)
        .then(() => console.log("Printed successfully"))
        .catch(err => console.error("Print failed:", err));


}

// HandleFeedAndConfirm removed — manual mode-switch procedure supersedes the old software feed command.