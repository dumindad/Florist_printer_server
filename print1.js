const WebSocket = require("ws");
const escpos = require('escpos');
escpos.USB = require('escpos-usb');

// WebSocket Server
const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (ws) => {
    console.log("Client connected");

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message);
            console.log("Received message:", data);

            if (data.type === "PRINT") {
                const idVendor = data.idVendor;
                const idProduct = data.idProduct;
                // const content = data.content;

                try {

                    const invoiceNo = data.invoiceNo;
                    const createdAt = data.create;

                    const items = data.items;
                    const paymentMethod = data.paymentMethod;

                    // Connect to USB printer
                    const device = new escpos.USB(idVendor, idProduct);
                    const printer = new escpos.Printer(device);

                    device.open(function () {
                        escpos.Image.load(`${__dirname}/logo.png`, (image) => {
                            printer.align('CT').image(image, 's8')
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
                                .text(`Date: ${new Date(createdAt).toLocaleString()}`)
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
                                printer.text(`Cash Tendered: ${currency} ${cashTendered}`)
                                    .text(`Change: ${currency} ${cashBalance}`);
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
                            ws.send(JSON.stringify({ success: true }));
                        });
                    });
                } catch (err) {
                    console.error("Print failed:", err);
                    ws.send(JSON.stringify({ success: false, error: err.message }));
                }
            }
        } catch (err) {
            console.error("Error:", err);
            ws.send(JSON.stringify({ success: false, error: err.message }));
        }
    });

    ws.on("close", () => console.log("Client disconnected"));
});

console.log("WebSocket server listening on ws://localhost:8080");


// --------------------------------------------------------------------

// const WebSocket = require("ws");
// const escpos = require("escpos");
// escpos.USB = require("escpos-usb");

// const wss = new WebSocket.Server({ port: 8080 });

// let printQueue = []; // Queue to store failed print jobs
// let labelPrintQueue = []; // Queue for label printer
// let isPrinting = false; // Flag to prevent simultaneous print jobs
// let isLabelPrinting = false;

// wss.on("connection", (ws) => {
//     console.log("Client connected");

//     ws.on("message", async (message) => {
//         try {
//             const data = JSON.parse(message);
//             console.log("Received message:", data);

//             if (data.type === "PRINT") {
//                 queuePrintJob(data, ws);
//             } else if (data.type === "PRINT_PACKAGE_PRODUCTS") {
//                 // console.log("Received message idVendor:", idVendorFormatted);
//                 // printPackageLabel(data)
//                 queuePrintJobToMakeB(data, ws)
//             }
//         } catch (err) {
//             console.error("Error:", err);
//             ws.send(JSON.stringify({ success: false, error: err.message }));
//         }
//     });

//     ws.on("close", () => console.log("Client disconnected"));
// });

// console.log("WebSocket server listening on ws://localhost:8080");

// // Function to queue the print job
// function queuePrintJob(printJob, ws) {
//     printQueue.push({ printJob, ws });
//     processPrintQueue(); // Process the queue
// }
// // Function to queue the print job for package products
// function queuePrintJobToMakeB(printJob, ws) {
//     labelPrintQueue.push({ printJob, ws, isLabelPrinting: true });
//     processLabelPrintQueue(); // Process the queue
// }

// // Function to process the print queue
// function processPrintQueue() {
//     if (isPrinting || printQueue.length === 0) return;

//     isPrinting = true;
//     const { printJob, ws } = printQueue.shift(); // Get the next job

//     printReceipt(printJob)
//         .then(() => {
//             ws.send(JSON.stringify({ success: true }));
//             isPrinting = false;
//             processPrintQueue(); // Process next job
//         })
//         .catch((error) => {
//             console.error("Print failed:", error);
//             ws.send(JSON.stringify({ success: false, error: error.message }));
//             printQueue.push({ printJob, ws }); // Requeue the failed job
//             isPrinting = false;
//             setTimeout(processPrintQueue, 5000); // Retry after 5 seconds
//         });
// }

// // Process label print queue
// function processLabelPrintQueue() {
//     if (isLabelPrinting || labelPrintQueue.length === 0) return;

//     isLabelPrinting = true;
//     const { printJob, ws } = labelPrintQueue.shift();
//     console.log("lable how to", printJob)
//     printPackageLabel(printJob)
//         .then(() => {
//             ws.send(JSON.stringify({ success: true }));
//             isLabelPrinting = false;
//             processLabelPrintQueue();
//         })
//         .catch((error) => {
//             console.error("Print failed:", error);
//             ws.send(JSON.stringify({ success: false, error: error.message }));
//             labelPrintQueue.push({ printJob, ws });
//             isLabelPrinting = false;
//             setTimeout(processLabelPrintQueue, 5000);
//         });
// }

// // Function to print package product labels
// async function printPackageLabel(data) {
//     return new Promise((resolve, reject) => {
//         try {
//             // const idVendorFormatted = String(data.idVendor).padStart(4, '0');
//             // console.log("idVendor", idVendorFormatted)
//             const idVendor = parseInt(data.idVendor, 16); // Convert hex string to integer
//             const idProduct = parseInt(data.idProduct, 16);
//             const device = new escpos.USB(idVendor, idProduct);
//             const printer = new escpos.Printer(device);

//             device.open((error) => {
//                 if (error) {
//                     return reject(new Error("Printer not connected or unavailable"));
//                 }
// console.log("print--",  data.packageProducts.forEach((product) => {product.name, product.quantity}))
// data.packageProducts.forEach((product) => {
//     console.log("Name:", product.name, "Quantity:", product.quantity);
// });
//                 printer.align("CT")
//                     .style("B")
//                     .size(1, 1)
//                     .text("Order Label")
//                     .text("----------------------")
//                     .align("LT");

//                 data.packageProducts.forEach((product) => {
//                     printer.text(`Product: ${product.name}`)
//                         .text(`Quantity: ${product.quantity}`)
//                         .text("Items:");
//                     product.packagedItemList.forEach((item, index) => {
//                         printer.text(`  ${index + 1}. ${item.name} - ${item.quantity} (${item.description2})`);
//                     });
//                     printer.text("----------------------");
//                 });

//                 printer.cut().close(() => resolve()); // Print job completed
//             });
//             console.log("finish print log")
//         } catch (error) {
//             reject(error);
//         }
//     });
// }


// // Function to handle printing with error handling
// async function printReceipt(data) {
//     return new Promise((resolve, reject) => {
//         try {
//             const device = new escpos.USB(data.idVendor, data.idProduct);
//             const printer = new escpos.Printer(device);

//             device.open((error) => {
//                 if (error) {
//                     return reject(new Error("Printer not connected or unavailable"));
//                 }

//                 escpos.Image.load(`${__dirname}/logo.png`, (image) => {
//                     printer.align("CT").image(image, "s8")
//                         .style("b")
//                         .size(1, 1)
//                         .text("Marabedda Florist")
//                         .size(0, 0)
//                         .text(data.store_address)
//                         .text(data.telphone)
//                         .text("------------------------------------------------")
//                         .align("LT")
//                         .text(`Order ID: ${(data.invoiceNo).toString()}`)
//                         .text(`Date: ${new Date(data.create).toLocaleString()}`)
//                         .text("------------------------------------------------");

//                     // Print each item
//                     data.items.forEach((item) => {
//                         const itemTotal = (Number(item.price) * item.quantity).toFixed(2);
//                         printer.tableCustom([
//                             { text: item.name, width: 0.4, align: "LEFT" },
//                             { text: item.quantity.toString(), width: 0.1, align: "RIGHT" },
//                             { text: `${Number(item.price).toFixed(2)}`, width: 0.2, align: "RIGHT" },
//                             { text: ` ${itemTotal} `, width: 0.3, align: "RIGHT" },
//                         ]);
//                     });

//                     printer.text("------------------------------------------------")
//                         .align("RT")
//                         .text(`Subtotal: Rs. ${data.subtotal.toFixed(2)}`)
//                         .text(`Total: Rs. ${data.total.toFixed(2)}`)
//                         .text("------------------------------------------------")
//                         .align("CT")
//                         .text("Thank you for your purchase!")
//                         .text("Come again soon!")
//                         .cut()
//                         .close(() => resolve()); // Print job completed
//                 });
//             });
//         } catch (error) {
//             reject(error);
//         }
//     });
// }
