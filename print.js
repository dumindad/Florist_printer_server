const WebSocket = require("ws");
const escpos = require("escpos");
const sharp = require('sharp');
const http = require("http");
const fs = require("fs");
const path = require("path");
escpos.USB = require("escpos-usb");

// ── Version metadata (read from version.json) ──
let APP_VERSION = "1.0.0";
let BUILD_DATE = "unknown";
try {
  const versionPath = path.join(__dirname, "version.json");
  if (fs.existsSync(versionPath)) {
    const v = JSON.parse(fs.readFileSync(versionPath, "utf8"));
    APP_VERSION = v.version || APP_VERSION;
    BUILD_DATE = v.buildDate || BUILD_DATE;
  }
} catch (e) {
  // ignore
}

// ── HTTP server for health/version checks ──
const httpServer = http.createServer((req, res) => {
  // CORS (allow admin panel from any origin)
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
      name: "POS Printer Server",
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
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
    return;
  }

  res.writeHead(200);
  res.end("POS Printer Server — WebSocket on ws://localhost:8080");
});

httpServer.listen(8081, "127.0.0.1", () => {
  console.log("📡 HTTP health server on http://127.0.0.1:8081");
});

// ── WebSocket server for print jobs ──
const wss = new WebSocket.Server({ port: 8080 });

let printQueue = []; // Queue to store failed print jobs
let labelPrintQueue = []; // Queue for label printer
let isPrinting = false; // Flag to prevent simultaneous print jobs
let isLabelPrinting = false;

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
                // console.log("Received message idVendor:", idVendorFormatted);
                // printPackageLabel(data)
                queuePrintJobToMakeB(data, ws)
            } else if (data.type === "PRINT_LABEL_CODE") {

                // print Package Label (bar code or QR code)
                // queuePrintJobToLabel(data, ws)
                // processBarCodePrint(data, ws)
                // debugUSBDevice(data)
                const LABEL = "LABEL";
                // debugUsbConnection();
                // setPrinterMode(LABEL)
                printLabel(data, ws)


                // initializePrinter().then(() => {
                //     // Proceed with printing
                //     // checkPrinterMode(data, ws)
                // }).catch(error => console.error('Fatal error:', error));
            }
        } catch (err) {
            console.error("Error:", err);
            ws.send(JSON.stringify({ success: false, error: err.message }));
        }
    });

    ws.on("close", () => console.log("Client disconnected"));
});

console.log("WebSocket server listening on ws://localhost:8080");

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

// Function to process the print queue
function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;

    isPrinting = true;
    const { printJob, ws } = printQueue.shift(); // Get the next job
    console.log("processPrintQueue", printJob)
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
function processLabelPrintQueue() {
    if (isLabelPrinting || labelPrintQueue.length === 0) return;

    isLabelPrinting = true;
    const { printJob, ws } = labelPrintQueue.shift();
    console.log("lable how to", printJob)
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
    return new Promise((resolve, reject) => {
        try {
            // const idVendorFormatted = String(data.idVendor).padStart(4, '0');
            // console.log("idVendor", idVendorFormatted)
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
            const device = new escpos.USB(data.idVendor, data.idProduct);
            const printer = new escpos.Printer(device);
            const { invoiceNo, create, items, paymentMethod } = data;
            // Add before device.open:
            const logoPath = `${__dirname}/images/logo.png`;
            const processedLogo = `${__dirname}/images/logo_processed.png`;
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

async function setPrinterMode(targetMode) {
    const device = usb.findByIds(VENDOR_ID, PRODUCT_ID);

    try {
        // 1. Open with timeout
        await new Promise((resolve, reject) => {
            device.open(err => err ? reject(err) : resolve());
            setTimeout(() => reject(new Error('Open timeout (5s)')), 5000);
        });

        // 2. Basic check
        if (!device.interfaces?.[0]?.descriptors) {
            throw new Error('Invalid interface structure');
        }

        // 3. Control transfer verification
        await new Promise((resolve, reject) => {
            device.controlTransfer(
                0x40, 0x00, 0x0000, 0x0000, Buffer.alloc(0),
                err => err ? reject(err) : resolve()
            );
        });

        //TODO Rest of mode switching code...
        const command = targetMode === 'TSPL'
            ? Buffer.from('SET MODE TSPL\r\nWRITE\r\n', 'ascii')
            : Buffer.from('SET MODE ESC\r\nWRITE\r\n', 'ascii');

        return new Promise((resolve, reject) => {
            outEndpoint.transfer(command, err => {
                iface.release(true, () => { });
                device.close();
                if (err) return reject(new Error(`Transfer failed: ${err.message}`));
                resolve(true);
            });
        });

    } finally {
        device.close();
    }
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
        process.exit(1);
    }
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