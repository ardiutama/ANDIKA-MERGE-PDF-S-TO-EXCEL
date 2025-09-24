import React, { useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";

//xlsx is globally available from the script tag in index.html
declare var XLSX: any;
//pdfjsLib is globally available from the script tag in index.html
declare var pdfjsLib: any;

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<string>("idle"); // idle, processing, success, error
  const [progressMessage, setProgressMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [downloadLink, setDownloadLink] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [failedFiles, setFailedFiles] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFilesToList = (fileList: FileList | null) => {
    if (fileList) {
      const newFiles = Array.from(fileList);
      if (newFiles.length > 0) {
        setFiles(prevFiles => {
          const existingFileKeys = new Set(prevFiles.map((f: File) => `${f.name}-${f.size}`));
          const uniqueNewFiles = newFiles.filter((f: File) => !existingFileKeys.has(`${f.name}-${f.size}`));
          return [...prevFiles, ...uniqueNewFiles];
        });
        setStatus('idle');
        setDownloadLink(null);
        setErrorMessage("");
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFilesToList(event.target.files);
    // Reset the input value to allow selecting the same file(s) again after clearing
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    addFilesToList(event.dataTransfer.files);
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
    setProgress(0);
    setFailedFiles([]);
    if(fileInputRef.current) {
        fileInputRef.current.value = "";
    }
  };

  const processFiles = useCallback(async () => {
    if (files.length === 0) {
      setErrorMessage("Please select at least one PDF file.");
      return;
    }

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setErrorMessage("API_KEY environment variable not set.");
      setStatus("error");
      return;
    }

    setStatus("processing");
    setErrorMessage("");
    setDownloadLink(null);
    setProgress(0);
    setFailedFiles([]);
    
    try {
      const ai = new GoogleGenAI({ apiKey });
      
      const allSummaries = [];
      const localFailedFiles: string[] = [];

      setProgressMessage(`Starting processing for ${files.length} files...`);

      // Process files sequentially to avoid browser crashes and API rate limiting
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgressMessage(`Processing file ${i + 1}/${files.length}: ${file.name}`);
        setProgress(((i + 1) / files.length) * 100);

        const summary = await extractSummaryFromPdf(file, ai);
        
        if (summary) {
          allSummaries.push(summary);
        } else {
          localFailedFiles.push(file.name);
        }
      }

      setFailedFiles(localFailedFiles);

      const validSummaries = allSummaries.filter(s => s.JUMLAH_PENUMPANG > 0);

      if (validSummaries.length === 0) {
        let errorMsg = "Could not extract any voyage summaries from the provided PDFs. Please ensure the files are valid manifests and try again.";
        if (localFailedFiles.length > 0) {
          errorMsg = `None of the files could be processed successfully. Failed files: ${localFailedFiles.length}.`;
        }
        setErrorMessage(errorMsg);
        setStatus("error");
        return;
      }

      setProgressMessage(`Generating Excel file...`);
      
      const desiredHeadersInOrder = [
        "NO",
        "TANGGAL",
        "WAKTU",
        "NOMOR VOYAGE",
        "PELABUHAN MUAT",
        "PELABUHAN BONGKAR",
        "LAMA PELAYARAN",
        "JUMLAH PENUMPANG G",
        "KETERANGAN"
      ];
      
      const dataForSheet = validSummaries.map((summary, index) => ({
        "NO": index + 1,
        "TANGGAL": summary.TANGGAL || '',
        "WAKTU": summary.WAKTU || '',
        "NOMOR VOYAGE": summary.NOMOR_VOYAGE || '',
        "PELABUHAN MUAT": summary.PELABUHAN_MUAT || '',
        "PELABUHAN BONGKAR": summary.PELABUHAN_BONGKAR || '',
        "LAMA PELAYARAN": "",
        "JUMLAH PENUMPANG G": summary.JUMLAH_PENUMPANG || 0,
        "KETERANGAN": ""
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(dataForSheet, { header: desiredHeadersInOrder });
      XLSX.utils.book_append_sheet(workbook, worksheet, "Compiled Voyage Logs");
      
      const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      setDownloadLink(url);
      
      let finalMessage = `Processing complete! ${validSummaries.length} files successfully processed.`;
      if (localFailedFiles.length > 0) {
          finalMessage = `Processing complete! ${validSummaries.length} succeeded, ${localFailedFiles.length} failed.`;
      }
      setProgressMessage(finalMessage);
      setStatus("success");
    } catch (error) {
      console.error("Processing error:", error);
      let detailedErrorMessage = "An unexpected error occurred. Please check the console for details.";
      if (error instanceof Error) {
          if (error.message.includes("API Key")) {
            detailedErrorMessage = "An error occurred with the API Key. Please ensure it is valid.";
          } else {
            detailedErrorMessage = error.message;
          }
      }
      setErrorMessage(detailedErrorMessage);
      setStatus("error");
    }
  }, [files]);

  const extractSummaryFromPdf = async (file: File, ai: GoogleGenAI): Promise<any | null> => {
    try {
      const typedarray = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument(typedarray).promise;

      if (pdf.numPages === 0) {
          return null;
      }

      let totalPassengers = 0;
      let voyageInfo: any = {};

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not get canvas context");
        }
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport: viewport }).promise;
        const dataUrl = canvas.toDataURL("image/png");
        const imagePart = { inlineData: { data: dataUrl.split(",")[1], mimeType: "image/png" } };

        if (i === 1) { // First page: get header info + passenger count
          const schema = {
            type: Type.OBJECT,
            properties: {
              "TANGGAL": { type: Type.STRING, description: "Tanggal keberangkatan lengkap dengan nama hari. Contoh: 'Kamis, 18 Juli 2024'" },
              "WAKTU": { type: Type.STRING, description: "Waktu keberangkatan dalam format HH:MM. Contoh: '08:00'" },
              "NOMOR_VOYAGE": { type: Type.STRING, description: "Nama kapal dan/atau nama panggilan dari 'NAMA KAPAL / NAMA PANGGILAN'. Contoh: 'KM. SULTAN HASANUDDIN / YCG12'" },
              "PELABUHAN_MUAT": { type: Type.STRING, description: "Pelabuhan asal atau pelabuhan muat dari 'Pelabuhan Asal'" },
              "PELABUHAN_BONGKAR": { type: Type.STRING, description: "Pelabuhan tujuan atau pelabuhan bongkar dari 'Pelabuhan Tujuan'" },
              "JUMLAH_PENUMPANG": { type: Type.INTEGER, description: "Total jumlah baris penumpang yang valid dalam tabel HANYA DI HALAMAN INI. Hitung baris yang berisi data penumpang, abaikan header tabel." },
            },
            required: ["TANGGAL", "WAKTU", "NOMOR_VOYAGE", "PELABUHAN_MUAT", "PELABUHAN_BONGKAR", "JUMLAH_PENUMPANG"]
          };
          const prompt = `
            Analisis gambar halaman pertama dari manifest penumpang ini.
            1. Ekstrak informasi header berikut:
               - Tanggal: Tanggal lengkap termasuk nama hari dari 'Hari/Tanggal/Jam'.
               - Waktu: Waktu keberangkatan dari 'Hari/Tanggal/Jam'.
               - Nomor Voyage: Nama kapal/panggilan dari 'NAMA KAPAL / NAMA PANGGILAN'.
               - Pelabuhan Muat: Dari 'Pelabuhan Asal'.
               - Pelabuhan Bongkar: Dari 'Pelabuhan Tujuan'.
            2. HITUNG secara akurat jumlah baris penumpang dalam tabel HANYA PADA HALAMAN INI. Abaikan baris header tabel.

            Kembalikan hasilnya sebagai SATU objek JSON tunggal yang sesuai dengan skema yang diberikan.
          `;
           const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [ { text: prompt }, imagePart ] },
            config: {
              responseMimeType: "application/json",
              responseSchema: schema,
            }
          });

          const page1Data = JSON.parse(response.text);
          voyageInfo = {
             TANGGAL: page1Data.TANGGAL,
             WAKTU: page1Data.WAKTU,
             NOMOR_VOYAGE: page1Data.NOMOR_VOYAGE,
             PELABUHAN_MUAT: page1Data.PELABUHAN_MUAT,
             PELABUHAN_BONGKAR: page1Data.PELABUHAN_BONGKAR,
          };
          totalPassengers += page1Data.JUMLAH_PENUMPANG || 0;
        } else { // Subsequent pages: just count passengers
          const schema = {
            type: Type.OBJECT,
            properties: {
               "JUMLAH_PENUMPANG": { type: Type.INTEGER, description: "Total jumlah baris penumpang yang valid dalam tabel HANYA DI HALAMAN INI. Hitung baris yang berisi data penumpang. Jangan sertakan header." },
            },
            required: ["JUMLAH_PENUMPANG"]
          };
           const prompt = `
            Ini adalah halaman lanjutan dari manifest penumpang.
            HITUNG secara akurat jumlah baris penumpang dalam tabel HANYA PADA HALAMAN INI. Abaikan baris header tabel.
            
            Kembalikan hasilnya sebagai SATU objek JSON tunggal yang hanya berisi jumlah penumpang di halaman ini.
          `;
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [ { text: prompt }, imagePart ] },
            config: {
              responseMimeType: "application/json",
              responseSchema: schema,
            }
          });
          
          const pageNData = JSON.parse(response.text);
          totalPassengers += pageNData.JUMLAH_PENUMPANG || 0;
        }
      }

      return { ...voyageInfo, JUMLAH_PENUMPANG: totalPassengers };

    } catch (err) {
      console.error(`Failed to process ${file.name}:`, err);
      return null;
    }
  };

  const renderAppContent = () => {
    switch(status) {
      case 'processing':
        return (
          <div className="text-center w-full">
            <h3 className="text-xl font-semibold text-sky-300 mb-4">Processing Files...</h3>
            <div className="w-full bg-slate-700 rounded-full h-4 mb-2 border border-slate-600">
              <div 
                className="bg-sky-500 h-full rounded-full transition-all duration-300 ease-in-out" 
                style={{ width: `${progress}%` }}
              ></div>
            </div>
             <p className="text-sm text-slate-300 truncate">{progressMessage}</p>
          </div>
        );
      case 'success':
        return (
          <div className="text-center p-8 bg-slate-800 rounded-lg">
            <h2 className="text-2xl font-bold text-green-400 mb-2">Success!</h2>
            <p className="mb-6 text-slate-300">{progressMessage}</p>
            <a
              href={downloadLink!}
              download="Laporan_Voyage_Gabungan.xlsx"
              className="inline-block bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg transition-transform transform hover:scale-105"
            >
              Download Excel File
            </a>
            {failedFiles.length > 0 && (
                <div className="mt-6 text-left text-sm text-amber-400 max-w-md mx-auto">
                    <p className="font-semibold">The following {failedFiles.length} files could not be processed:</p>
                    <ul className="list-disc list-inside max-h-32 overflow-y-auto bg-slate-900/50 p-2 rounded mt-1 border border-slate-700">
                        {failedFiles.map(name => <li key={name} className="truncate">{name}</li>)}
                    </ul>
                </div>
            )}
            <button onClick={resetState} className="mt-6 text-sm text-sky-400 hover:text-sky-300">Start Over</button>
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
            <div 
              onClick={triggerFileSelect}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex justify-center items-center w-full px-6 py-10 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${isDragging ? 'border-sky-400 bg-sky-900/50' : 'border-slate-600 hover:border-sky-400'}`}
            >
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-slate-500" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                  <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="mt-2 text-slate-400">
                  <span className="font-semibold text-sky-400">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-slate-500">PDF files only</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-6">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-semibold">Selected Files ({files.length}):</h3>
                    <button 
                        onClick={resetState} 
                        className="text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors"
                        aria-label="Clear all selected files"
                    >
                        CLEAR ALL
                    </button>
                </div>
                <ul className="max-h-32 overflow-y-auto bg-slate-800 p-2 rounded-md border border-slate-700">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${index}`} className="text-sm text-slate-300 truncate">{file.name}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {files.length > 50 && (
                <div className="mt-4 p-3 bg-amber-900/20 text-amber-300 text-xs rounded-md border border-amber-800">
                    <strong>Warning:</strong> You have selected a large number of files. Processing may take a very long time. Please keep this browser tab open and connected to the internet.
                </div>
            )}

            {errorMessage && <p className="mt-4 text-sm text-red-400">{errorMessage}</p>}
            
            <button
              onClick={processFiles}
              disabled={files.length === 0}
              className="w-full mt-6 bg-sky-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-sky-700 disabled:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-400 transition-colors"
            >
              Process {files.length > 0 ? files.length : ''} Files
            </button>
          </>
        );
    }
  };
  
  const render = () => {
    return (
       <main className="bg-slate-800/50 p-8 rounded-xl shadow-2xl backdrop-blur-sm border border-slate-700">
          <input
            type="file"
            multiple
            accept=".pdf"
            onChange={handleFileChange}
            ref={fileInputRef}
            className="hidden"
          />
          {renderAppContent()}
        </main>
    );
  }

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
        {render()}
      </div>
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<App />);
