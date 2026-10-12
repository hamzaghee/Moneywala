const fs = require('fs');
const path = require('path');

async function extractText(pdfPath) {
  const pdfjsLib = require(path.join(__dirname, '..', 'public', 'vendor', 'pdf.min.js'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(__dirname, '..', 'public', 'vendor', 'pdf.worker.min.js');
  
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

(async () => {
  try {
    const filePath = process.argv[2];
    if (!filePath) {
      console.error('Please provide a PDF file path.');
      process.exit(1);
    }
    const text = await extractText(path.resolve(filePath));
    console.log(text);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
