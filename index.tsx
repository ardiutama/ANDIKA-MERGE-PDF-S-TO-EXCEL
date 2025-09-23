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
      setProgressMessage(`2/4: Extracting data from ${files.length} PDFs...`);
      const extractionPromises = files.map(file => extractTablesFromPdf(file, ai, updateEtr));
      const extractionResults = await Promise.all(extractionPromises);
      let allExtractedRows: any[] = extractionResults.flat();

      if (allExtractedRows.length === 0) {
        setErrorMessage("No data could be extracted from the provided PDFs.");
        setStatus("error");
        return;
      }
      
      // Refine ETR estimate with actual row count and schema design step
      const actualStandardizationChunks = Math.ceil(allExtractedRows.length / DATA_CHUNK_SIZE);
      totalChunksRef.current = totalExtractionChunks + actualStandardizationChunks; // Extraction + Standardization

      // Step 3: Standardize and aggregate voyage data
      setProgressMessage(`3/4: Summarizing ${allExtractedRows.length} total extracted rows...`);
      const finalData = await standardizeAndMerge(allExtractedRows, ai, (msg) => setProgressMessage(`3/4: ${msg}`), updateEtr);

      if(finalData.length === 0) {
        setErrorMessage("Could not standardize the extracted voyage data.");
        setStatus("error");
        return;
      }

      // Step 4: Create Excel file
      setProgressMessage("4/4: Generating Excel file...");
      setEtr(""); // Hide ETR for the final step
      
      const desiredHeadersInOrder = [
        "NO",
        "TANGGAL",
        "NOMOR VOYAGE",
        "PELABUHAN MUAT",
        "PELABUHAN BONGKAR",
        "LAMA PELAYARAN",
        "JUMLAH PENUMPANG"
      ];

      const dataForSheet = finalData.map((row, index) => ({
        "NO": index + 1,
        "TANGGAL": row.TANGGAL,
        "NOMOR VOYAGE": row.NOMOR_VOYAGE,
        "PELABUHAN MUAT": row.PELABUHAN_MUAT,
        "PELABUHAN BONGKAR": row.PELABUHAN_BONGKAR,
        "LAMA PELAYARAN": row.LAMA_PELAYARAN,
        "JUMLAH PENUMPANG": row.JUMLAH_PENUMPANG,
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(dataForSheet, { header: desiredHeadersInOrder });
      XLSX.utils.book_append_sheet(workbook, worksheet, "Compiled Voyage Logs");
      
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
                            const viewport = page.getViewport({ scale: 1.0 });
                            const canvas = document.createElement("canvas");
                            const context = canvas.getContext("2d");
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                            await page.render({ canvasContext: context!, viewport: viewport }).promise;
                            const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
                            return { inlineData: { data: dataUrl.split(",")[1], mimeType: "image/jpeg" } };
                        }));
                        
                        const prompt = `Analyze these PDF pages and extract all tabular data into a single JSON array of objects. Each object represents a row.

Key Instructions:
1.  Identify all distinct column headers in any tables found.
2.  For each data row, create a JSON object.
3.  Every JSON object must have a key for every column header identified.
4.  If a cell is empty for a row, use a 'null' value for its key. Do not omit the key.
5.  If you find lists of passengers associated with a voyage, extract each passenger as a separate row but ensure voyage information (like voyage number, dates, ports) is copied to each passenger row.

If no tables are found, return an empty JSON array.`;
                        
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
                resolve(results.flat());

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
      
      const masterSchemaProperties = {
        "TANGGAL": { "type": Type.STRING, "description": "Date of the voyage (e.g., '2024-12-26')." },
        "NOMOR_VOYAGE": { "type": Type.STRING, "description": "The voyage number or identifier." },
        "PELABUHAN_MUAT": { "type": Type.STRING, "description": "The port of loading." },
        "PELABUHAN_BONGKAR": { "type": Type.STRING, "description": "The port of discharge." },
        "LAMA_PELAYARAN": { "type": Type.STRING, "description": "The duration of the voyage (e.g., '5 Hari' or '12 Jam')." },
        "JUMLAH_PENUMPANG": { "type": Type.INTEGER, "description": "The total count of passengers for the voyage." }
      };
      
      const standardizedHeaders = Object.keys(masterSchemaProperties);

      // Process all data in parallel chunks
      const chunks = [];
      for (let i = 0; i < allRows.length; i += DATA_CHUNK_SIZE) {
        chunks.push(allRows.slice(i, i + DATA_CHUNK_SIZE));
      }
      
      updateProgress(`Aggregating ${allRows.length} rows into voyage summaries...`);
      
      const config = {
        responseMimeType: "application/json",
        responseSchema: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                  "TANGGAL": { "type": Type.STRING },
                  "NOMOR_VOYAGE": { "type": Type.STRING },
                  "PELABUHAN_MUAT": { "type": Type.STRING },
                  "PELABUHAN_BONGKAR": { "type": Type.STRING },
                  "LAMA_PELAYARAN": { "type": Type.STRING },
                  "JUMLAH_PENUMPANG": { "type": Type.INTEGER }
                },
                required: standardizedHeaders,
            }
        },
        thinkingConfig: { thinkingBudget: 0 }
      };

      const transformationPromises = chunks.map(chunk => {
        const transformPrompt = `
You are a data aggregation and transformation engine. Your task is to process raw data extracted from voyage log PDFs and summarize it into one record per voyage.

**Master Schema (your final output for EACH unique voyage):**
${JSON.stringify(standardizedHeaders)}

**CRITICAL INSTRUCTIONS:**
1.  The raw data chunk below contains rows that might represent individual passengers or parts of a voyage log.
2.  Your primary goal is to **group all rows by a unique voyage identifier** (like 'nomor voyage', 'voyage no', etc.).
3.  For each unique voyage, you must create **a single summary JSON object**.
4.  **Calculate the 'JUMLAH_PENUMPANG'**: Count the number of unique passengers or rows associated with each voyage to get the total passenger count.
5.  **Extract Voyage Details**: From the rows for a given voyage, extract the 'TANGGAL', 'NOMOR_VOYAGE', 'PELABUHAN_MUAT', 'PELABUHAN_BONGKAR', and 'LAMA_PELAYARAN'. These values should be consistent for a single voyage.
6.  Map the extracted and calculated data to the Master Schema. Ensure every object in your response array contains all keys from the schema.
7.  If a value cannot be found or calculated, use a reasonable default like 'N/A' for strings or 0 for numbers.
8.  Your output must ONLY be a JSON array of these summary objects. Do not include any other text.

**Raw Data Chunk to Process:**
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
              download="compiled_voyage_logs.xlsx"
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
            AI PDF Voyage Log Extractor
          </h1>
          <p className="mt-2 text-lg text-slate-400">
            Extract voyage logs from multiple PDFs and merge them into a single Excel file.
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