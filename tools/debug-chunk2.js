const fs = require('fs');
const path = require('path');

function pdfTextLines(content) {
  const items = content.items.filter((it) => typeof it.str === 'string');
  const lines = new Map();
  for (const it of items) {
    const y = Math.round(it.transform[5]);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push(it);
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) =>
    its.sort((a, b) => a.transform[4] - b.transform[4]).map((it) => it.str).join(' ').trim()
  ).filter((l) => l).join('\n');
}

(async () => {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.error('Please provide a PDF file path.');
    process.exit(1);
  }

  const pdfjsLib = require(path.join(__dirname, '..', 'public', 'vendor', 'pdf.min.js'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(__dirname, '..', 'public', 'vendor', 'pdf.worker.min.js');
  
  console.log(`Reading ${targetFile}...`);
  const data = new Uint8Array(fs.readFileSync(path.resolve(targetFile)));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    text += pdfTextLines(await (await doc.getPage(i)).getTextContent()) + '\n';
  }

  console.log(`Extracted ${text.length} characters. Sending to /api/import/parse...`);

  const res = await fetch('http://127.0.0.1:5173/api/import/parse', {
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ text }),
  });

  console.log('status:', res.status);
  const responseText = await res.text();
  console.log(responseText);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
