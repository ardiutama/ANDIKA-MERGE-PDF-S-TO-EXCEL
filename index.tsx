import React, { useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";

//xlsx is globally available from the script tag in index.html
declare var XLSX: any;
//pdfjsLib is globally available from the script tag in index.html
declare var pdfjsLib: any;

const PDF_PAGE_CHUNK_SIZE = 5; // Process 5 pages at a time in parallel

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

  const aggregateData = (rows: any[]): any[] => {
      const aggregationMap = new Map<string, any[]>();

      for (const row of rows) {
          // If the row is already a summary row with a passenger count, treat it as its own unique group.
          const passengerCount = parseInt(String(row.JUMLAH_PENUMPANG), 10);
          if (!isNaN(passengerCount) && passengerCount > 0) {
               // Create a unique key to prevent merging with other rows.
               const key = `summary-${row.NOMOR_VOYAGE || ''}-${row.TANGGAL || ''}-${row.PELABUHAN_MUAT || ''}-${row.PELABUHAN_BONGKAR || ''}-${Math.random()}`;
               aggregationMap.set(key, [row]); // Store as a group of one
               continue;
          }

          // Otherwise, group individual passenger rows by voyage segment to count them.
          const key = [
              row.NOMOR_VOYAGE || 'N/A',
              row.TANGGAL || 'N/A',
              row.PELABUHAN_MUAT || 'N/A',
              row.PELABUHAN_BONGKAR || 'N/A',
          ].join('||');
          
          if (!aggregationMap.has(key)) {
              aggregationMap.set(key, []);
          }
          aggregationMap.get(key)!.push(row);
      }

      const aggregatedResults: any[] = [];
      for (const group of aggregationMap.values()) {
          if (group.length === 0) continue;
          const firstRow = group[0];
          
          const passengerCount = parseInt(String(firstRow.JUMLAH_PENUMPANG), 10);
          // If the first row in the group was a summary row, use its count. Otherwise, count the items in the group.
          const isPreAggregated = group.length === 1 && !isNaN(passengerCount) && passengerCount > 0;

          aggregatedResults.push({
              TANGGAL: firstRow.TANGGAL,
              NOMOR_VOYAGE: firstRow.NOMOR_VOYAGE,
              PELABUHAN_MUAT: firstRow.PELABUHAN_MUAT,
              PELABUHAN_BONGKAR: firstRow.PELABUHAN_BONGKAR,
              LAMA_PELAYARAN: firstRow.LAMA_PELAYARAN,
              JUMLAH_PENUMPANG: isPreAggregated ? passengerCount : group.length,
          });
      }

      return aggregatedResults;
  };


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
      
      setProgressMessage("1/4: Analyzing workload...");
      const pageCounts = await Promise.all(
        files.map(async (file) => {
          const typedarray = new Uint8Array(await file.arrayBuffer());
          const pdf = await pdfjsLib.getDocument(typedarray).promise;
          return pdf.numPages;
        })
      );
      const totalChunks = pageCounts.reduce((acc, count) => acc + Math.ceil(count / PDF_PAGE_CHUNK_SIZE), 0);
      totalChunksRef.current = totalChunks;
      startTimeRef.current = Date.now();

      setProgressMessage(`2/4: Extracting & Standardizing data from ${files.length} PDFs...`);
      const extractionPromises = files.map(file => extractAndStandardizeTablesFromPdf(file, ai, updateEtr));
      const extractionResults = await Promise.all(extractionPromises);
      const standardizedData: any[] = extractionResults.flat();

      if (standardizedData.length === 0) {
        setErrorMessage("No structured data could be extracted from the provided PDFs. Please check the files and try again.");
        setStatus("error");
        return;
      }

      setProgressMessage(`3/4: Aggregating ${standardizedData.length} rows...`);
      const finalData = aggregateData(standardizedData);

      setProgressMessage("4/4: Generating Excel file...");
      setEtr("");
      
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
        "TANGGAL": row.TANGGAL || 'N/A',
        "NOMOR VOYAGE": row.NOMOR_VOYAGE || 'N/A',
        "PELABUHAN MUAT": row.PELABUHAN_MUAT || 'N/A',
        "PELABUHAN BONGKAR": row.PELABUHAN_BONGKAR || 'N/A',
        "LAMA PELAYARAN": row.LAMA_PELAYARAN || 'N/A',
        "JUMLAH PENUMPANG": parseInt(String(row.JUMLAH_PENUMPANG), 10) || 0,
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

  const extractAndStandardizeTablesFromPdf = async (file: File, ai: GoogleGenAI, onChunkComplete: () => void): Promise<any[]> => {
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
                
                const masterSchema = {
                    "TANGGAL": { type: Type.STRING },
                    "NOMOR_VOYAGE": { type: Type.STRING },
                    "PELABUHAN_MUAT": { type: Type.STRING },
                    "PELABUHAN_BONGKAR": { type: Type.STRING },
                    "LAMA_PELAYARAN": { type: Type.STRING },
                    "NAMA_PENUMPANG": { type: Type.STRING },
                    "JUMLAH_PENUMPANG": { type: Type.STRING },
                };
                
                const prompt = `
Anda adalah ahli ekstraksi data dari gambar PDF. Tugas Anda adalah menganalisis gambar-gambar ini, menemukan semua data tabular, dan mengubahnya menjadi satu array JSON terstruktur.

Skema Target JSON (Setiap objek dalam array HARUS memiliki kunci-kunci ini):
- TANGGAL
- NOMOR_VOYAGE
- PELABUHAN_MUAT
- PELABUHAN_BONGKAR
- LAMA_PELAYARAN
- NAMA_PENUMPANG
- JUMLAH_PENUMPANG

Instruksi Penting:
1.  **Ekstrak SEMUA Baris:** Identifikasi semua tabel dan ekstrak setiap baris.
2.  **Petakan ke Skema:** Untuk setiap baris yang diekstrak, buat objek JSON yang sesuai dengan Skema Target di atas. Lakukan pemetaan kolom terbaik yang Anda bisa (misalnya, 'No. Pelayaran' -> 'NOMOR_VOYAGE', 'Asal' -> 'PELABUHAN_MUAT', 'Tujuan' -> 'PELABUHAN_BONGKAR', 'Nama' -> 'NAMA_PENUMPANG', 'Jumlah' -> 'JUMLAH_PENUMPANG').
3.  **Isi Data:**
    - Jika baris tersebut adalah untuk satu penumpang, isi 'NAMA_PENUMPANG' dan biarkan 'JUMLAH_PENUMPANG' null.
    - Jika baris tersebut adalah ringkasan perjalanan, isi 'JUMLAH_PENUMPANG' dari kolom jumlah dan biarkan 'NAMA_PENUMPANG' null.
4.  **Nilai Kosong:** Jika suatu nilai untuk kunci Skema Target tidak dapat ditemukan di baris, gunakan nilai 'N/A' atau null.
5.  **Output:** Kembalikan HANYA array JSON tunggal yang berisi semua objek yang telah diekstrak dan distandarisasi. Jika tidak ada tabel yang ditemukan, kembalikan array JSON kosong.
`;

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
                        
                        const response = await ai.models.generateContent({
                          model: 'gemini-2.5-flash',
                          contents: [ { parts: [ { text: prompt }, ...imageParts ] } ],
                          config: { 
                              responseMimeType: "application/json",
                              responseSchema: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: masterSchema,
                                }
                              }
                          }
                        });

                        const tables = JSON.parse(response.text);
                        return Array.isArray(tables) ? tables : [];
                    } catch (e) {
                        console.warn(`Could not process or parse pages ${pageChunk.join(', ')} of ${file.name}`, e);
                        return [];
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