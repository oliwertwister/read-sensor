import { createExtractorFromData } from "./vendor/unrar/index.esm.js";

self.onmessage = async (event) => {
  try {
    const wasmResponse = await fetch("./vendor/unrar/js/unrar.wasm");
    if (!wasmResponse.ok) throw new Error("RAR decoder WASM is unavailable.");
    const wasmBinary = await wasmResponse.arrayBuffer();
    const extractor = await createExtractorFromData({ wasmBinary, data: event.data.buffer });
    const files = [];
    let total = 0;
    const result = extractor.extract();
    for (const item of result.files) {
      if (!item.extraction || item.fileHeader?.flags?.directory) continue;
      total += item.extraction.byteLength;
      if (total > event.data.maxExpandedBytes) throw new Error("Expanded RAR exceeds the 20 MiB safety limit.");
      const bytes = item.extraction;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      files.push({ name: item.fileHeader.name, buffer });
    }
    const transfers = files.map((file) => file.buffer);
    self.postMessage({ ok: true, files }, transfers);
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) });
  }
};
