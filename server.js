require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { DocumentAnalysisClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");

const app = express();
const upload = multer({ dest: "uploads/" });

const client = new DocumentAnalysisClient(
    process.env.AZURE_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_KEY)
);

/**
 * Helper to clean extracted text and remove unnecessary newlines
 */
const clean = (text) => text ? text.replace(/\n/g, " ").replace(/\s\s+/g, ' ').trim() : "";

const parseBizFileData = (result) => {
    const content = result.content;
    const tables = result.tables || [];

    const clean = (text) => text ? text.replace(/\n/g, " ").replace(/\s\s+/g, ' ').trim() : "";

    // Multi-line regex helper
    const findField = (regex, index = 1) => {
        const match = content.match(regex);
        return match && match[index] ? clean(match[index]) : "";
    };

    const data = {
        company_name: findField(/Name of Company\s*:\s*([\s\S]*?)(?=Former Name|UEN|$)/i),
        uen: findField(/UEN\s*:\s*(\w+)/i),
        incorporation_date: findField(/Incorporation Date\s*:\s*(.*)/i),
        // FIX: Capture company type when the label is followed by text BEFORE the colon
        company_type: findField(/Company Type\s*([\s\S]*?)(?=\s*:|$)/i),
        financial_year_end: findField(/FYE As At Date of Last AR\s*:\s*(.*)/i),
        registered_address: findField(/Registered Office Address\s*:\s*([\s\S]*?)(?=Date of Address|$)/i),
        business_activity_primary: findField(/Primary Activity\s*:\s*([\s\S]*?)(?=Secondary Activity|$)/i),
        business_activity_secondary: findField(/Secondary Activity\s*:\s*([\s\S]*?)(?=Verify Document|$)/i),
        officers: [],
        shareholders: [],
        issued_share_capital: [],
        paid_up_capital: [],
        charges: []
    };

    tables.forEach((table) => {
        const rows = [];
        table.cells.forEach(cell => {
            if (!rows[cell.rowIndex]) rows[cell.rowIndex] = [];
            rows[cell.rowIndex][cell.columnIndex] = clean(cell.content);
        });

        const tableText = rows.flat().join(" ").toUpperCase();

        // FIX: Officers Extraction (Look for Appointment Date or Position)
        if (tableText.includes("DESIGNATION") || tableText.includes("DATE OF APPOINTMENT")) {
            rows.slice(1).forEach(row => {
                if (row.length >= 4 && row[0] !== "") {
                    data.officers.push({
                        name: row[0],
                        id_number: row[1],
                        address: row[2],
                        designation: row[4] || "DIRECTOR",
                        nationality: row[3],
                        appointment_date: row[5] || ""
                    });
                }
            });
        }

        // FIX: Shareholders Extraction
        if (tableText.includes("SHAREHOLDER") || (tableText.includes("SHARES") && tableText.includes("ADDRESS"))) {
            rows.slice(1).forEach(row => {
                // Ensure it's a data row by checking if the 3rd column is a number
                if (row.length >= 3 && /\d/.test(row[2])) {
                    data.shareholders.push({
                        name: row[0],
                        id_number: row[1],
                        shares_count: parseInt(row[2].replace(/,/g, '')) || 0,
                        address: row[3] || ""
                    });
                }
            });
        }

        // FIX: Charges Extraction (Often on Page 2 or 3)
        if (tableText.includes("CHARGE NUMBER") || tableText.includes("AMOUNT SECURED")) {
            rows.slice(1).forEach(row => {
                if (row.length >= 3 && row[0] !== "NIL" && row[0] !== "") {
                    data.charges.push({
                        charge_number: row[0],
                        date_registered: row[1],
                        currency: row[2],
                        amount: row[3]
                    });
                }
            });
        }

        // Capital Tables
        if (tableText.includes("ORDINARY") && (tableText.includes("ISSUED") || tableText.includes("PAID-UP"))) {
            const isPaidUp = tableText.includes("PAID-UP");
            rows.forEach(row => {
                if (row.some(c => c.includes("SINGAPORE DOLLAR"))) {
                    const capital = {
                        amount: row[0],
                        shares: row[1],
                        currency: "SGD",
                        type: "ORDINARY"
                    };
                    isPaidUp ? data.paid_up_capital.push(capital) : data.issued_share_capital.push(capital);
                }
            });
        }
    });

    return data;
};

app.post("/ocr", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded." });

        const fileBuffer = fs.readFileSync(req.file.path);
        // Using "prebuilt-layout" is best for tables
        const poller = await client.beginAnalyzeDocument("prebuilt-layout", fileBuffer);
        const result = await poller.pollUntilDone();

        const extractedData = parseBizFileData(result);
        extractedData.filePath = req.file.path;

        const response = {
            status: 200,
            message: "BizFile uploaded successfully.",
            payload: {
                data: extractedData
            },
            data: result,
        };

        // Note: Clean up file after processing if needed
        // fs.unlinkSync(req.file.path); 

        return res.json(response);
    } catch (error) {
        console.error("OCR Error:", error);
        return res.status(500).json({ status: 500, message: "OCR failed", error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ message: `Welcome to azure OCR api.` });
})

app.listen(8080, () => console.log("Server running on port 8080"));