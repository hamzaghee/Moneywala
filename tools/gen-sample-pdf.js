// Generates two text-based test PDFs and sanity-checks extraction:
//  - tools/sample-statement.pdf : 3 pages, 42 txn rows (multi-page, repeated headers)
//  - tools/sample-long.pdf      : 260 txn rows (~10k chars -> exercises chunked parsing)
const fs = require('fs');
const path = require('path');

function esc(s) { return s.replace(/[()\\]/g, (m) => '\\' + m); }
function pageContent(lines) {
  return lines.map((l, i) => `BT /F1 10 Tf 50 ${760 - i * 16} Td (${esc(l)}) Tj ET`).join('\n');
}
function buildMultiPagePdf(pages) {
  const kids = [];
  const pageObjNums = [];
  const contentObjNums = [];
  let objNum = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(objNum);
    contentObjNums.push(objNum + 1);
    objNum += 2;
    kids.push(`${pageObjNums[i]} 0 R`);
  }
  const fontNum = objNum;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>\nendobj\n`,
  ];
  for (let i = 0; i < pages.length; i++) {
    const content = pageContent(pages[i]);
    objects.push(`${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>\nendobj\n`);
    objects.push(`${contentObjNums[i]} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`);
  }
  objects.push(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objects) { offsets.push(out.length); out += o; }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return out;
}

const MERCHANTS = [
  'ROGER S COFFEE', 'NETFLIX.COM', 'SHELL GAS STATION', 'UHG SUPERMARKET', 'TIM HORTONS #2201',
  'AMAZON MKTP US', 'DOORDASH', 'STARBUCKS #9912', 'GUMBYS GROCERY', 'COSTCO WHSE 4471',
  'UBER * TRIP', 'LYFT RIDE', 'GOLDEN CRUST BAKERY', 'PETSMART 2210', 'CVS PHARMACY 887',
  'MCDONALDS 1122', 'SUBWAY SANDWICH', 'WHOLE FOODS 332', 'FARMERS MARKET', 'BOOKS A MILLION',
  'GAMESTOP 5521', 'MICROSOFT BILL', 'APPLE.COM BILL', 'GOOGLE ONE', 'SPOTIFY.US',
  'DISNEY PLUS', 'GRAND PLAZA HOTEL', 'AIR INDIA PAY', 'CITY TAXI CO', 'TIP DASH APP',
];
function monthDay(i, startMonthIdx) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = (startMonthIdx + Math.floor(i / 28)) % 12;
  const day = (i % 28) + 1;
  return `${names[monthIdx]} ${String(day).padStart(2, '0')}`;
}
function rowFor(i, startMonthIdx) {
  if (i % 24 === 11) return { date: monthDay(i, startMonthIdx), desc: 'DIRECT DEPOSIT SALARY', amount: 2450.0, kind: 'income' };
  if (i % 24 === 19) return { date: monthDay(i, startMonthIdx), desc: 'CARD PAYMENT VISA 4321', amount: 300.0, kind: 'transfer' };
  if (i % 24 === 23) return { date: monthDay(i, startMonthIdx), desc: 'MAINTENANCE FEE', amount: 2.95, kind: 'fee' };
  const m = MERCHANTS[i % MERCHANTS.length];
  const amount = Math.round(((i * 7.13) % 120 + 2) * 100) / 100;
  return { date: monthDay(i, startMonthIdx), desc: m, amount, kind: 'expense' };
}
function rowsToLines(rows) {
  return rows.map(r => `${r.date}  ${r.desc.padEnd(26, ' ')} ${r.amount.toFixed(2)}`);
}

// --- sample statement: 3 pages, 42 rows ---
const sampleRows = [];
for (let i = 0; i < 42; i++) sampleRows.push(rowFor(i, 6));
const perPage = 14;
const pages = [];
for (let p = 0; p < 3; p++) {
  const chunk = sampleRows.slice(p * perPage, (p + 1) * perPage);
  const lines = [];
  if (p === 0) {
    lines.push('ACME BANK - STATEMENT');
    lines.push('Account ending 7788    Period: Jul 2026 - Aug 2026');
    lines.push('');
  } else {
    lines.push('ACME BANK - STATEMENT (continued)');
    lines.push('');
  }
  lines.push(...rowsToLines(chunk));
  lines.push('');
  lines.push(`Page ${p + 1} of 3`);
  if (p === 2) {
    lines.push('Closing balance: 1842.11');
    lines.push('This is a computer generated statement.');
  }
  pages.push(lines);
}
fs.writeFileSync(path.join(__dirname, 'sample-statement.pdf'), buildMultiPagePdf(pages), 'latin1');

// --- long statement: 260 rows (~10k chars -> 2 chunks) ---
const longRows = [];
for (let i = 0; i < 260; i++) longRows.push(rowFor(i, 6));
const longPer = 40;
const longPages = [];
for (let p = 0; p < Math.ceil(260 / longPer); p++) {
  const chunk = longRows.slice(p * longPer, (p + 1) * longPer);
  longPages.push([
    p === 0 ? 'ACME BANK - STATEMENT (LONG PERIOD)' : 'ACME BANK - STATEMENT (continued)',
    p === 0 ? 'Account ending 7788    Period: Jul 2026 - Dec 2026' : '',
    ...rowsToLines(chunk),
    `Page ${p + 1}`,
  ]);
}
fs.writeFileSync(path.join(__dirname, 'sample-long.pdf'), buildMultiPagePdf(longPages), 'latin1');
console.log('wrote sample-statement.pdf (' + fs.statSync(path.join(__dirname, 'sample-statement.pdf')).size + ' bytes, 3 pages, 42 rows)');
console.log('wrote sample-long.pdf (' + fs.statSync(path.join(__dirname, 'sample-long.pdf')).size + ' bytes, ' + longPages.length + ' pages, 260 rows)');

// --- extraction sanity (same code path as the browser) ---
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
  const pdfjsLib = require(path.join(__dirname, '..', 'public', 'vendor', 'pdf.min.js'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(__dirname, '..', 'public', 'vendor', 'pdf.worker.min.js');
  for (const f of ['sample-statement.pdf', 'sample-long.pdf']) {
    const p = path.join(__dirname, f);
    const data = new Uint8Array(fs.readFileSync(p));
    const doc = await pdfjsLib.getDocument({ data }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) text += pdfTextLines(await (await doc.getPage(i)).getTextContent()) + '\n';
    const nonEmpty = text.trim().split('\n').filter(l => l).length;
    console.log(`${f}: ${doc.numPages} pages, ${text.trim().length} chars, ${nonEmpty} non-empty lines`);
  }
})().catch((e) => { console.error('EXTRACT SANITY FAILED:', e.message); process.exit(1); });
