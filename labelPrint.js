
const WebSocket = require("ws");

const escposUSB = require('escpos-usb');
const usb = require('usb');
const os = require("os");

// "usb": "2.9.0",
// "node-windows": "1.0.0-beta.8",

// "@types/ws": "^8.18.0",
//     "escpos": "3.0.0-alpha.6",
//     "escpos-usb": "3.0.0-alpha.4",
//     "express": "^4.21.2",
//     "node-printer": "^1.0.4",
//     "node-thermal-printer": "^4.4.4",  
//     "pkg": "^5.8.1",
//     "sharp": "^0.34.1",
//     "ws": "^8.18.1"

const wss = new WebSocket.Server({ port: 8080 });

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
        barcodeCommand = `BARCODE 10,50,"128",60,1,0,2,2,"${printData.barcodeValue}"`;
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