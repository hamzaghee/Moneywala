const fs = require('fs');
const path = require('path');
const pdfjsLib = require('../public/vendor/pdf.min.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = '../public/vendor/pdf.worker.min.js';

async function extractText(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str).join(' ');
    text += strings + '\n';
  }
  return text;
}

async function importFile(pdfPath) {
  console.log(`\n--- Importing: ${pdfPath} ---`);
  const text = await extractText(pdfPath);
  console.log(`Extracted ${text.length} characters.`);

  const res = await fetch('http://127.0.0.1:5173/api/import/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const result = await res.json();
  if (result.ok) {
    console.log(`SUCCESS!`);
    console.log(`Statement: ${result.statement.period}`);
    console.log(`Transactions: ${result.transactions.length}`);
    console.log(`Partial: ${result.partial}`);
    if (result.failedChunks.length > 0) console.log(`Failed Chunks: ${result.failedChunks.length}`);
  } else {
    console.log(`FAILED: ${result.error}`);
  }
}

(async () => {
  // Note: using absolute paths for the files we copied
  try {
    await importFile(path.resolve('2026-09-16.pdf'));
    await importFile(path.resolve('September 4, 2026.pdf'));
  } catch (e) {
    console.error('Error in import script:', e);
  }
})();
