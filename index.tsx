import React, { useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";

//xlsx is globally available from the script tag in index.html
declare var XLSX: any;
//pdfjsLib is globally available from the script tag in index.html
declare var pdfjsLib: any;

const PDF_PAGE_CHUNK_SIZE = 5; // Process 5 pages at a time in parallel
const DATA_CHUNK_SIZE = 100; // Standardize 100 rows at a time in parallel

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [apiKey, setApiKey] = useState<string>("");
  const [status, setStatus] = useState<string>("idle"); // idle, processing, success, error
  const [progressMessage, setProgressMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [downloadLink, setDownloadLink] = useState<string | null>(null);
  const [etr, setEtr] = useState<string>(""); // Estimated Time Remaining

  const fileInputRef = useRef<HTMLInputElement>(null);
  const totalChunksRef = useRef(0);
  const completedChunksRef = useRef(0);
  const startTimeRef = useRef(0);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      const selectedFiles = Array.from(event.target.files);
      if (selectedFiles.length > 0) {
        setFiles(selectedFiles);
        setStatus('idle');
        setDownloadLink(null);
        setErrorMessage("");
      }
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const resetState = () => {
    setFiles([]);
    setStatus('idle');
    setProgressMessage("");
    setErrorMessage("");
    setDownloadLink(null);
    setEtr("");
    if(fileInputRef.current) {
        fileInputRef.current.value = "";
    }
  };
  
  const formatTime = (ms: number) => {
    if (ms <= 0) return "";
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    let parts = [];
    if (minutes > 0) {
      parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    }
    if (seconds > 0) {
      parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
    }
    if (parts.length === 0) {
        return "finishing up...";
    }
    return `about ${parts.join(' ')} remaining`;
  };

  const updateEtr = useCallback(() => {
    completedChunksRef.current += 1;
    if (startTimeRef.current === 0 || totalChunksRef.current === 0) return;

    const elapsedTime = Date.now() - startTimeRef.current;
    const timePerChunk = elapsedTime / completedChunksRef.current;
    const remainingChunks = totalChunksRef.current - completedChunksRef.current;
    const remainingTime = timePerChunk * remainingChunks;
    
    setEtr(formatTime(remainingTime));
  }, []);


  const processFiles = useCallback(async () => {
    if (!apiKey) {
      setErrorMessage("Please enter your Google GenAI API key.");
      return;
    }
    if (files.length === 0) {
      setErrorMessage("Please select at least one PDF file.");
      return;
    }
     if (files.length <= 10) {
        setErrorMessage("Please select more than 10 PDF files.");
        setStatus("error");
        return;
    }

    setStatus("processing");
    setErrorMessage("");
    setDownloadLink(null);
    setEtr("");
    completedChunksRef.current = 0;
    totalChunksRef.current = 0;
    
    try {
      const ai = new GoogleGenAI({ apiKey });
      
      // Step 1: Pre-computation for ETR
      setProgressMessage("1/4: Analyzing workload...");
      const pageCounts = await Promise.all(
        files.map(async (file) => {
          const typedarray = new Uint8Array(await file.arrayBuffer());
          const pdf = await pdfjsLib.getDocument(typedarray).promise;
          return pdf.numPages;
        })
      );
      const totalExtractionChunks = pageCounts.reduce((acc, count) => acc + Math.ceil(count / PDF_PAGE_CHUNK_SIZE), 0);
      // Rough guess for total chunks before we know the row count
      totalChunksRef.current = totalExtractionChunks * 2 + 1; // Extraction + Rough guess for standardization + 1 for schema design
      startTimeRef.current = Date.now();

      // Step 2: Extract tables from all PDFs in parallel
      setProgressMessage(`2/4: Extracting tables from ${files.length} PDFs...`);
      const extractionPromises = files.map(file => extractTablesFromPdf(file, ai, updateEtr));
      const extractionResults = await Promise.all(extractionPromises);
      let allExtractedRows: any[] = extractionResults.flat();

      if (allExtractedRows.length === 0) {
        setErrorMessage("No tables could be extracted from the provided PDFs.");
        setStatus("error");
        return;
      }
      
      // Refine ETR estimate with actual row count and schema design step
      const actualStandardizationChunks = Math.ceil(allExtractedRows.length / DATA_CHUNK_SIZE);
      totalChunksRef.current = totalExtractionChunks + 1 + actualStandardizationChunks; // Extraction + 1 for schema design + Standardization

      // Step 3: Design Schema, then Standardize and merge tables in parallel
      setProgressMessage(`3/4: Standardizing ${allExtractedRows.length} total rows...`);
      const finalData = await standardizeAndMerge(allExtractedRows, ai, (msg) => setProgressMessage(`3/4: ${msg}`), updateEtr);

      if(finalData.length === 0) {
        setErrorMessage("Could not standardize the extracted table data.");
        setStatus("error");
        return;
      }

      // Step 4: Create Excel file
      setProgressMessage("4/4: Generating Excel file...");
      setEtr(""); // Hide ETR for the final step
      
      const desiredHeadersInOrder = [
        "NO",
        "HARI, TANGGAL",
        "JAM",
        "NAMA KAPAL / NAMA PANGGILAN",
        "GROSS TONNAGE",
        "Pelabuhan Asal",
        "Pelabuhan Tujuan",
        "BOARDING PASS",
        "NAMA PENUMPANG",
        "JENIS KELAMIN",
        "USIA",
        "STATUS USIA",
        "ALAMAT"
      ];

      const dataForSheet = finalData.map((row, index) => ({
        "NO": index + 1,
        "HARI, TANGGAL": row.HARI_TANGGAL,
        "JAM": row.JAM,
        "NAMA KAPAL / NAMA PANGGILAN": row.NAMA_KAPAL_PANGGILAN,
        "GROSS TONNAGE": row.GROSS_TONNAGE,
        "Pelabuhan Asal": row.PELABUHAN_ASAL,
        "Pelabuhan Tujuan": row.PELABUHAN_TUJUAN,
        "BOARDING PASS": row.BOARDING_PASS,
        "NAMA PENUMPANG": row.NAMA_PENUMPANG,
        "JENIS KELAMIN": row.JENIS_KELAMIN,
        "USIA": row.USIA,
        "STATUS USIA": row.STATUS_USIA,
        "ALAMAT": row.ALAMAT,
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(dataForSheet, { header: desiredHeadersInOrder });
      XLSX.utils.book_append_sheet(workbook, worksheet, "Compiled Data");
      
      const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      setDownloadLink(url);
      
      setProgressMessage("Processing complete!");
      setStatus("success");
    } catch (error) {
      console.error("Processing error:", error);
      const message = error instanceof Error ? error.message : "An unknown error occurred. Check if your API key is valid and has access to the Gemini API.";
      setErrorMessage(message);
      setStatus("error");
    }
  }, [files, apiKey, updateEtr]);

  const extractTablesFromPdf = async (file: File, ai: GoogleGenAI, onChunkComplete: () => void): Promise<any[]> => {
    const fileReader = new FileReader();
    return new Promise((resolve, reject) => {
        fileReader.onload = async (event) => {
            try {
                const typedarray = new Uint8Array(event.target!.result as ArrayBuffer);
                const pdf = await pdfjsLib.getDocument(typedarray).promise;
                const totalPages = pdf.numPages;

                if (totalPages === 0) {
                    resolve([]);
                    return;
                }

                const pageChunks: number[][] = [];
                for (let p = 0; p < totalPages; p += PDF_PAGE_CHUNK_SIZE) {
                    pageChunks.push(Array.from({ length: Math.min(PDF_PAGE_CHUNK_SIZE, totalPages - p) }, (_, i) => p + i + 1));
                }

                const chunkProcessingPromises = pageChunks.map(async (pageChunk) => {
                    try {
                        const imageParts = await Promise.all(pageChunk.map(async (pageNum) => {
                            const page = await pdf.getPage(pageNum);
                            const viewport = page.getViewport({ scale: 1.0 }); // Reduced scale for performance
                            const canvas = document.createElement("canvas");
                            const context = canvas.getContext("2d");
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                            await page.render({ canvasContext: context!, viewport: viewport }).promise;
                            const dataUrl = canvas.toDataURL("image/jpeg", 0.8); // Added compression
                            return { inlineData: { data: dataUrl.split(",")[1], mimeType: "image/jpeg" } };
                        }));
                        
                        const prompt = `Analyze these PDF pages and extract all tables into a single JSON array of objects. Each object represents a row.

Follow these critical steps:
1.  **Identify ALL column headers** across the entire width of the table, even if the columns below the headers are completely empty.
2.  For each row of data, create a JSON object.
3.  **Crucially, every JSON object MUST include a key for EVERY column header you identified in step 1.**
4.  If a cell is empty for a particular row, include the corresponding key in the JSON object with a 'null' value. Do not omit the key.

Also handle this special case: Some tables list multiple people under one household. This looks like a complete row followed by several rows with only a name. For these 'name-only' rows, create a full record by copying all data (like household ID, address, etc.) from the last complete row, and just replace the name. Every person should have a complete record.

If no tables are found, return an empty array.`;
                        
                        const response = await ai.models.generateContent({
                          model: 'gemini-2.5-flash',
                          contents: [ { parts: [ { text: prompt }, ...imageParts ] } ],
                          config: { responseMimeType: "application/json" }
                        });

                        const tables = JSON.parse(response.text);
                        return Array.isArray(tables) ? tables : [];
                    } catch (e) {
                        console.warn(`Could not process or parse pages ${pageChunk.join(', ')} of ${file.name}`, e);
                        return []; // Return empty array on failure
                    } finally {
                        onChunkComplete();
                    }
                });
                
                const results = await Promise.all(chunkProcessingPromises);
                const extractedRows = results.flat();
                // Add filename to each row for traceability
                const rowsWithFilename = extractedRows.map(row => ({
                    ...row,
                    NAMA_FILE_PDF: file.name
                }));
                resolve(rowsWithFilename);

            } catch (err) {
                console.error(`Error processing PDF ${file.name}:`, err);
                reject(err);
            }
        };
        fileReader.onerror = (err) => reject(err);
        fileReader.readAsArrayBuffer(file);
    });
  };
  
  const standardizeAndMerge = async (allRows: any[], ai: GoogleGenAI, updateProgress: (msg: string) => void, onChunkComplete: () => void): Promise<any[]> => {
      if (allRows.length === 0) return [];
      
      // Step 1: Use a fixed, predefined schema based on the desired passenger manifest format.
      updateProgress("Applying standardized manifest schema...");
      const masterSchemaProperties = {
        "HARI_TANGGAL": { "type": "STRING", "description": "Combined Day and Date of travel (e.g., 'Thursday, December 26, 2024'). Expected column header: 'HARI, TANGGAL'." },
        "JAM": { "type": "STRING", "description": "Time of departure (e.g., '18:30'). Expected column header: 'JAM'." },
        "NAMA_KAPAL_PANGGILAN": { "type": "STRING", "description": "Ship Name / Call Name (e.g., 'KM. SULTAN HASANUDDIN / YCCB2'). Expected column header: 'NAMA KAPAL / NAMA PANGGILAN'." },
        "GROSS_TONNAGE": { "type": "STRING", "description": "Gross Tonnage (e.g., '1000GT'). Expected column header: 'GROSS TONNAGE'." },
        "PELABUHAN_ASAL": { "type": "STRING", "description": "Port of Origin. Expected column header: 'Pelabuhan Asal'." },
        "PELABUHAN_TUJUAN": { "type": "STRING", "description": "Port of Destination. Expected column header: 'Pelabuhan Tujuan'." },
        "BOARDING_PASS": { "type": "STRING", "description": "Boarding Pass number. Expected column header: 'BOARDING PASS'." },
        "NAMA_PENUMPANG": { "type": "STRING", "description": "Passenger's full name. Expected column header: 'NAMA PENUMPANG'." },
        "JENIS_KELAMIN": { "type": "STRING", "description": "Gender ('Laki-Laki' or 'Perempuan'). Expected column header: 'JENIS KELAMIN'." },
        "USIA": { "type": "STRING", "description": "Age, including units (e.g., '28 Tahun'). Expected column header: 'USIA'." },
        "STATUS_USIA": { "type": "STRING", "description": "Age status ('DEWASA' or 'ANAK'). Expected column header: 'STATUS USIA'." },
        "ALAMAT": { "type": "STRING", "description": "Passenger's address. Expected column header: 'ALAMAT'." },
      };
      
      onChunkComplete(); // Count this step as one completed chunk for ETR, replacing the dynamic schema design step.

      const standardizedHeaders = Object.keys(masterSchemaProperties);

      // Step 2. Process all data in parallel chunks based on the master schema
      const chunks = [];
      for (let i = 0; i < allRows.length; i += DATA_CHUNK_SIZE) {
        chunks.push(allRows.slice(i, i + DATA_CHUNK_SIZE));
      }
      
      updateProgress(`Standardizing ${allRows.length} rows into the new schema...`);
      
      const config = {
        responseMimeType: "application/json",
        responseSchema: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: masterSchemaProperties,
                required: standardizedHeaders, // Ensure all keys are present
            }
        },
        thinkingConfig: { thinkingBudget: 0 }
      };

      const transformationPromises = chunks.map(chunk => {
        const transformPrompt = `
You are a data transformation engine. Your task is to convert raw passenger manifest data into a clean, structured format based on a provided master schema.

**Master Schema (your output MUST follow this):**
${JSON.stringify(standardizedHeaders)}

**Data Source Note:**
The raw data comes from tables that might be spread across multiple pages. This means some columns that are constant for a whole manifest (like 'NAMA_KAPAL_PANGGILAN', 'JAM', 'HARI_TANGGAL', 'PELABUHAN_ASAL', 'PELABUHAN_TUJUAN', etc.) might only appear once at the top of a page, or not at all on subsequent pages for the same manifest.

**CRITICAL INSTRUCTIONS:**
1.  For each object in the raw data chunk below (which represents a row), create a new JSON object that strictly adheres to the Master Schema.
2.  **Intelligently map** fields from the raw data to the corresponding fields in the Master Schema. For example, a raw column named 'Nama Penumpang' or 'NAMA_PENUMPANG' should map to the 'NAMA_PENUMPANG' key in the schema.
3.  **Fill in missing values:** If a row is missing a value for a constant column (like ship name or date), you MUST infer it from other rows in the chunk that do have that value. All passengers in the same manifest should share the same ship name, date, time, origin, and destination.
4.  Ensure EVERY object in your response array contains ALL keys from the Master Schema.
5.  If a value for a key that is unique to a passenger (like 'NAMA_PENUMPANG' or 'ALAMAT') is truly missing and cannot be inferred, use 'null'.
6.  Your output must ONLY be the final, transformed JSON array for this chunk. Do not include any other text or explanations.

**Raw Data Chunk to Transform:**
${JSON.stringify(chunk)}
`;

        const promise = ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: transformPrompt,
            config
        });
        promise.finally(() => onChunkComplete());
        return promise;
    });

    const settledResults = await Promise.allSettled(transformationPromises);
    
    let finalStandardizedData: any[] = [];
    settledResults.forEach(result => {
        if (result.status === 'fulfilled') {
            try {
                const standardizedChunk = JSON.parse(result.value.text);
                if (Array.isArray(standardizedChunk)) {
                    finalStandardizedData.push(...standardizedChunk);
                }
            } catch (e) {
                console.warn("Failed to parse a transformed chunk:", e);
            }
        } else {
            console.error("A transformation chunk failed:", result.reason);
        }
    });

    return finalStandardizedData;
  };


  const renderContent = () => {
    switch(status) {
      case 'processing':
        return (
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-dashed rounded-full animate-spin border-sky-400 mx-auto"></div>
            <p className="mt-4 text-lg text-slate-300">{progressMessage}</p>
            {etr && <p className="mt-2 text-base font-medium text-sky-300">{etr}</p>}
          </div>
        );
      case 'success':
        return (
          <div className="text-center p-8 bg-slate-800 rounded-lg">
            <h2 className="text-2xl font-bold text-green-400 mb-4">Success!</h2>
            <p className="mb-6 text-slate-300">Your compiled Excel file is ready for download.</p>
            <a
              href={downloadLink!}
              download="compiled_data.xlsx"
              className="inline-block bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg transition-transform transform hover:scale-105"
            >
              Download Excel File
            </a>
            <button onClick={resetState} className="mt-4 ml-4 text-sm text-sky-400 hover:text-sky-300">Start Over</button>
          </div>
        );
      case 'error':
         return (
          <div className="text-center p-8 bg-red-900/20 border border-red-500 rounded-lg">
            <h2 className="text-2xl font-bold text-red-400 mb-4">An Error Occurred</h2>
            <p className="mb-6 text-slate-300">{errorMessage}</p>
            <button onClick={resetState} className="bg-sky-500 hover:bg-sky-600 text-white font-bold py-3 px-6 rounded-lg">
              Try Again
            </button>
          </div>
        );
      default: // idle
        return (
          <>
            <div className="mb-6">
              <label htmlFor="apiKey" className="block text-sm font-medium text-slate-300 mb-2">
                Google GenAI API Key
              </label>
              <input
                type="password"
                id="apiKey"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                className="w-full bg-slate-900/80 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition"
                aria-label="Google GenAI API Key"
              />
            </div>

            <div 
              onClick={triggerFileSelect}
              className="flex justify-center items-center w-full px-6 py-10 border-2 border-dashed border-slate-600 hover:border-sky-400 rounded-lg cursor-pointer transition-colors"
            >
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-slate-500" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                  <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="mt-2 text-slate-400">
                  <span className="font-semibold text-sky-400">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-slate-500">PDF files only (more than 10 required)</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-6">
                <h3 className="font-semibold mb-2">Selected Files:</h3>
                <ul className="max-h-32 overflow-y-auto bg-slate-800 p-2 rounded-md">
                  {files.map((file, index) => (
                    <li key={index} className="text-sm text-slate-300 truncate">{file.name}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {errorMessage && <p className="mt-4 text-sm text-red-400">{errorMessage}</p>}
            
            <button
              onClick={processFiles}
              disabled={files.length <= 10 || !apiKey}
              className="w-full mt-6 bg-sky-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-sky-700 disabled:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-400 transition-colors"
            >
              Process {files.length > 0 ? files.length : ''} Files
            </button>
          </>
        );
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-900 text-white font-sans">
      <div className="w-full max-w-2xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-emerald-500">
            AI PDF Table Extractor
          </h1>
          <p className="mt-2 text-lg text-slate-400">
            Merge tables from multiple PDFs into a single, clean Excel file.
          </p>
        </header>

        <main className="bg-slate-800/50 p-8 rounded-xl shadow-2xl backdrop-blur-sm border border-slate-700">
          <input
            type="file"
            multiple
            accept=".pdf"
            onChange={handleFileChange}
            ref={fileInputRef}
            className="hidden"
          />
          {renderContent()}
        </main>
      </div>
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<App />);