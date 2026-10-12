// End-to-end: statement PDF -> pdf.js text -> /api/import/parse (live LLM) -> shape + split checks.
// Usage: node tools/test-import-e2e.js [pdfPath] [minRows]
//   defaults: tools/sample-statement.pdf, 30 rows
const fs = require('fs');
const path = require('path');

const PDF = process.argv[2] || path.join(__dirname, 'sample-statement.pdf');
const MIN_ROWS = parseInt(process.argv[3] || '30', 10);

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
  const data = new Uint8Array(fs.readFileSync(PDF));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    text += pdfTextLines(await (await doc.getPage(i)).getTextContent()) + '\n';
  }
  console.log(`extracted: ${doc.numPages} pages, ${text.trim().length} chars`);

  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:5173/api/import/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const out = await res.json();
  console.log('status:', res.status, 'ms:', Date.now() - t0, 'chunks:', out.chunks, 'partial:', !!out.partial);
  if (!out.ok) { console.error('FAIL:', out.error); process.exit(1); }
  console.log('statement:', JSON.stringify(out.statement));
  console.log('rows:', out.transactions.length, '(min', MIN_ROWS + ')');
  const bad = out.transactions.filter(r =>
    !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(r.amount > 0) ||
    !['expense', 'income', 'transfer', 'fee', 'refund'].includes(r.type) ||
    typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1
  );
  console.log('rows with bad shape:', bad.length);
  out.transactions.slice(0, 4).forEach(r => console.log(' ', r.date, r.type, r.amount, r.description, `(${Math.round(r.confidence * 100)}%)`));

  // --- split using the REAL client helpers (dedupe + dup-flag + confidence) ---
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  function grab(fnName) {
    const start = appSrc.indexOf(`function ${fnName}(`);
    let i = appSrc.indexOf('{', start), depth = 0, j = i;
    for (; j < appSrc.length; j++) {
      if (appSrc[j] === '{') depth++;
      else if (appSrc[j] === '}') { depth--; if (depth === 0) break; }
    }
    return appSrc.slice(start, j + 1);
  }
  const code = ['normText', 'textTokens', 'findDuplicate', 'dedupeRows'].map(grab).join('\n');
  let state = { expenses: [], income: [] };
  const H = eval(`(function(){ ${code}; return { dedupeRows, findDuplicate }; })()`);
  const th = 0.85;
  const split = (rows) => {
    const ded = H.dedupeRows(rows);
    const flagged = ded.map(r => ({ ...r, dupOf: H.findDuplicate(r) }));
    const auto = flagged.filter(r => r.confidence >= th && r.type !== 'transfer' && !r.dupOf);
    return { ded: ded.length, flagged, auto: auto.length, queued: flagged.length - auto.length, dups: flagged.filter(r => r.dupOf).length };
  };

  state = { expenses: [], income: [] };
  const A = split(out.transactions);
  console.log(`\n[Case A fresh book] deduped: ${out.transactions.length} -> ${A.ded}, auto: ${A.auto}, queued: ${A.queued}, dup-flagged: ${A.dups}`);

  state = {
    expenses: out.transactions.filter(r => r.type !== 'income' && r.type !== 'refund').map(r => ({ date: r.date, description: r.description, amount: r.amount })),
    income: out.transactions.filter(r => r.type === 'income' || r.type === 'refund').map(r => ({ date: r.date, description: r.description, amount: r.amount })),
  };
  const B = split(out.transactions);
  console.log(`[Case B re-import] auto: ${B.auto} (must be 0), dup-flagged: ${B.dups}`);

  const ok = bad.length === 0
    && out.transactions.length >= MIN_ROWS
    && A.dups === 0
    && B.auto === 0
    && B.dups > 0
    && (!out.partial || (Array.isArray(out.failedChunks) && out.failedChunks.length > 0));
  console.log(ok ? '\nE2E PASS' : '\nE2E FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
