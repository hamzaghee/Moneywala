const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const BACKUPS_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 10;
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

const INSTANCES_DIR = path.join(__dirname, 'instances');
if (!fs.existsSync(INSTANCES_DIR)) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function defaultSettings() {
  return {
    llm: { baseUrl: 'http://127.0.0.1:8080', model: 'qwen3.8:27b-q4_K_M', timeoutMs: 300000 },
    import: { confidenceThreshold: 0.85 },
  };
}

function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const llm = raw.llm;
  if (llm && typeof llm === 'object') {
    if (typeof llm.baseUrl === 'string' && /^https?:\/\/[^\s/]+/.test(llm.baseUrl.trim())) {
      d.llm.baseUrl = llm.baseUrl.trim().replace(/\/+$/, '').slice(0, 300);
    }
    if (typeof llm.model === 'string' && llm.model.trim()) d.llm.model = llm.model.trim().slice(0, 100);
    const t = parseInt(llm.timeoutMs, 10);
    if (!isNaN(t) && t >= 5000 && t <= 3600000) d.llm.timeoutMs = t;
  }
  const imp = raw.import;
  if (imp && typeof imp === 'object') {
    const th = parseFloat(imp.confidenceThreshold);
    if (!isNaN(th) && th >= 0 && th <= 1) d.import.confidenceThreshold = th;
  }
  return d;
}

function defaultData() {
  return {
    expenses: [],
    income: [],
    budgets: [],
    savingsGoals: [],
    debts: [],
    accounts: [],
    recurringTemplates: [],
    alertsShown: {},
    settings: defaultSettings(),
    importQueue: [],
    importedStatements: [],
    currency: '$',
    categories: [
      'Housing', 'Food', 'Transport', 'Utilities', 'Insurance',
      'Medical', 'Entertainment', 'Shopping', 'Education',
      'Personal', 'Gifts', 'Savings', 'Travel', 'Other',
    ],
  };
}

const REC_FREQS = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function stringField(v) { return typeof v === 'string' ? v.slice(0, 500) : ''; }
function idStr(v) { return typeof v === 'string' && v ? v.slice(0, 40) : ''; }
function validDate(d) { return typeof d === 'string' && DATE_RE.test(d); }
function uid() {
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeTransactions(arr, kind) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const amount = parseFloat(t.amount);
    if (isNaN(amount) || amount <= 0 || amount > 1e12) continue;
    const rec = { id: idStr(t.id) || uid(), date: validDate(t.date) ? t.date : today(), amount };
    if (kind === 'expense') {
      rec.category = typeof t.category === 'string' && t.category ? t.category.slice(0, 50) : 'Other';
      rec.description = stringField(t.description);
      rec.goalId = t.goalId ? idStr(t.goalId) : null;
      rec.goalName = stringField(t.goalName);
      rec.tags = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string').map((s) => s.slice(0, 30)) : [];
      rec.notes = stringField(t.notes);
      rec.recurring = typeof t.recurring === 'string' && REC_FREQS.includes(t.recurring) ? t.recurring : null;
      rec.groupId = t.groupId ? idStr(t.groupId) : null;
      rec._splitChild = !!t._splitChild;
      rec.account = typeof t.account === 'string' ? t.account.slice(0, 100) : null;
    } else {
      rec.source = typeof t.source === 'string' && t.source ? t.source.slice(0, 50) : 'Uncategorized';
      rec.tags = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string').map((s) => s.slice(0, 30)) : [];
      rec.notes = stringField(t.notes);
      rec.recurring = typeof t.recurring === 'string' && REC_FREQS.includes(t.recurring) ? t.recurring : null;
    }
    out.push(rec);
  }
  return out.slice(0, 5000);
}

function normalizeBudgets(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    const amount = parseFloat(b.amount);
    if (isNaN(amount) || amount < 0) continue;
    const category = typeof b.category === 'string' && b.category ? b.category.slice(0, 50) : '';
    if (!category) continue;
    out.push({ id: idStr(b.id) || uid(), category, amount });
  }
  return out.slice(0, 500);
}

function normalizeGoals(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    const name = stringField(g.name).trim();
    if (!name) continue;
    const target = parseFloat(g.target);
    const current = isNaN(parseFloat(g.current)) ? 0 : parseFloat(g.current);
    if (isNaN(target) || target < 0) continue;
    out.push({
      id: idStr(g.id) || uid(),
      name,
      target,
      current: isFinite(current) && current >= 0 ? current : 0,
      deadline: validDate(g.deadline) ? g.deadline : '',
      createdAt: validDate(g.createdAt) ? g.createdAt : today(),
    });
  }
  return out.slice(0, 200);
}

function normalizeDebts(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    const name = stringField(d.name).trim();
    if (!name) continue;
    const balance = parseFloat(d.balance);
    const rate = parseFloat(d.rate ?? d.interestRate);
    const min = parseFloat(d.min ?? d.minPayment);
    if (isNaN(balance) || balance < 0) continue;
    out.push({
      id: idStr(d.id) || uid(),
      name,
      type: d.type === 'owed' ? 'owed' : (d.type === 'credit' ? 'credit' : 'loan'),
      balance,
      rate: isFinite(rate) && rate >= 0 ? rate : 0,
      min: isFinite(min) && min >= 0 ? min : 0,
    });
  }
  return out.slice(0, 200);
}

function normalizeAccounts(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    const name = stringField(a.name).trim();
    if (!name) continue;
    const balance = parseFloat(a.balance);
    if (isNaN(balance)) continue;
    out.push({ id: idStr(a.id) || uid(), name, type: a.type === 'cash' ? 'cash' : 'card', balance });
  }
  return out.slice(0, 200);
}

function normalizeTemplates(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const amount = parseFloat(t.amount);
    if (isNaN(amount) || amount <= 0 || amount > 1e12) continue;
    const freq = typeof t.frequency === 'string' && REC_FREQS.includes(t.frequency) ? t.frequency : 'monthly';
    const rec = { id: idStr(t.id) || uid(), type: t.type === 'income' ? 'income' : 'expense', amount, date: validDate(t.date) ? t.date : today(), frequency: freq };
    if (rec.type === 'expense') {
      rec.category = typeof t.category === 'string' && t.category ? t.category.slice(0, 50) : 'Other';
      rec.description = stringField(t.description);
      rec.goalId = t.goalId ? idStr(t.goalId) : null;
      rec.tags = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string').map((s) => s.slice(0, 30)) : [];
      rec.notes = stringField(t.notes);
    } else {
      rec.source = typeof t.source === 'string' && t.source ? t.source.slice(0, 50) : 'Uncategorized';
      rec.tags = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string').map((s) => s.slice(0, 30)) : [];
      rec.notes = stringField(t.notes);
    }
    out.push(rec);
  }
  return out.slice(0, 500);
}

function normalizeData(raw) {
  const out = defaultData();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.currency === 'string' && raw.currency) out.currency = raw.currency.slice(0, 10);
  if (Array.isArray(raw.categories)) {
    const cats = raw.categories.filter((c) => typeof c === 'string' && c).map((c) => String(c).slice(0, 50));
    if (cats.length) out.categories = cats;
  }
  out.expenses = normalizeTransactions(raw.expenses, 'expense');
  out.income = normalizeTransactions(raw.income, 'income');
  out.budgets = normalizeBudgets(raw.budgets);
  out.savingsGoals = normalizeGoals(raw.savingsGoals);
  out.debts = normalizeDebts(raw.debts);
  out.accounts = normalizeAccounts(raw.accounts);
  out.recurringTemplates = normalizeTemplates(raw.recurringTemplates);
  if (raw.alertsShown && typeof raw.alertsShown === 'object' && !Array.isArray(raw.alertsShown)) {
    const shown = {};
    for (const k of Object.keys(raw.alertsShown).slice(0, 500)) shown[k] = true;
    out.alertsShown = shown;
  }
  out.settings = normalizeSettings(raw.settings);
  out.importQueue = normalizeImportQueue(raw.importQueue);
  out.importedStatements = normalizeImportedStatements(raw.importedStatements);
  return out;
}

/* ---------- statement import (LLM) ---------- */
const IMPORT_TEXT_LIMIT = 120000;
const IMPORT_CHUNK_SIZE = 8000;
const IMPORT_TXN_TYPES = ['expense', 'income', 'transfer', 'fee', 'refund'];

function chunkText(text) {
  if (text.length <= IMPORT_CHUNK_SIZE) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > IMPORT_CHUNK_SIZE) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty model response');
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model response');
  return JSON.parse(t.slice(start, end + 1));
}

function normalizeImportQueue(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const t of arr.slice(0, 200)) {
    if (!t || typeof t !== 'object') continue;
    const amount = parseFloat(t.amount);
    if (isNaN(amount) || amount <= 0 || amount > 1e9) continue;
    const type = IMPORT_TXN_TYPES.includes(t.type) ? t.type : 'expense';
    out.push({
      id: idStr(t.id) || uid(),
      date: validDate(t.date) ? t.date : '',
      description: stringField(t.description).slice(0, 200),
      amount,
      type,
      confidence: Math.min(1, Math.max(0, parseFloat(t.confidence) || 0.5)),
      category: typeof t.category === 'string' ? t.category.slice(0, 50) : null,
      source: typeof t.source === 'string' ? t.source.slice(0, 50) : null,
    });
  }
  return out;
}

function normalizeImportedStatements(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr.slice(-200)) {
    if (!s || typeof s !== 'object') continue;
    const hash = typeof s.hash === 'string' ? s.hash.trim() : '';
    if (!/^[a-f0-9]{64}$/i.test(hash)) continue;
    out.push({
      hash: hash.toLowerCase(),
      fileName: stringField(s.fileName).slice(0, 150),
      importedAt: validDate(s.importedAt) ? s.importedAt : today(),
      added: Math.min(10000, parseInt(s.added, 10) || 0),
      queued: Math.min(10000, parseInt(s.queued, 10) || 0),
    });
  }
  return out;
}

function normalizeImportedTxns(raw, categories) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const t of list.slice(0, 500)) {
    if (!t || typeof t !== 'object') continue;
    const amount = parseFloat(t.amount);
    if (isNaN(amount) || amount <= 0 || amount > 1e9) continue;
    const type = IMPORT_TXN_TYPES.includes(t.type) ? t.type : 'expense';
    const confidence = Math.min(1, Math.max(0, parseFloat(t.confidence) || 0.5));
    const rec = { date: validDate(t.date) ? t.date : '', description: stringField(t.description).slice(0, 200), amount, type, confidence, category: null, source: null };
    if (type === 'income') {
      rec.source = typeof t.source === 'string' && t.source.trim() ? t.source.trim().slice(0, 50) : 'Uncategorized';
    } else if (typeof t.category === 'string' && categories.includes(t.category.trim())) {
      rec.category = t.category.trim().slice(0, 50);
    }
    out.push(rec);
  }
  return out;
}

function yearHint(text) {
  const counts = {};
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  let best = null, n = 0;
  for (const [y, c] of Object.entries(counts)) if (c > n) { best = y; n = c; }
  return best;
}

function buildParsePrompt(text, categories, currency, ctxLines) {
  const rules = [
    'You are a precise parser of bank and credit-card statements.',
    'You receive extracted text from ONE statement and must extract every individual transaction.',
    '',
    'Respond with ONLY one JSON object — no markdown fences, no commentary — exactly in this shape:',
    '{"statement":{"kind":"bank or credit_card or unknown","period":"YYYY-MM-DD..YYYY-MM-DD or empty","account":"masked number or empty"},"transactions":[{"date":"YYYY-MM-DD or empty","description":"merchant or short label as printed","amount":12.34,"type":"expense or income or transfer or fee or refund","category":"one allowed category or null","source":"income source or null","confidence":0.9}]}',
    '',
    'Rules:',
    '- amount is always the positive absolute value.',
    '- expense: money paid out (purchases, withdrawals, interest charged).',
    '- income: money received from outside (payroll, deposits, remittances).',
    '- refund: a reversal of a previous purchase.',
    '- fee: explicit bank/card service fee lines only.',
    '- transfer: movement between your own accounts, card payments, deposits to your own account. Never classify transfers as income.',
    '- Skip running balances, totals, minimum-due lines, interest summaries and any non-transactional text.',
    `- For "category" use ONLY one of: ${categories.join(', ')}. Use null when none fits.`,
    '- confidence: your honest 0.0-1.0 confidence that date, amount and type are all correct. Be conservative when ambiguous.',
    '- If the statement text contains no transactions, return an empty transactions array.',
  ];
  for (const line of ctxLines || []) rules.push(line);
  const system = rules.join('\n');
  const user = `Currency: ${currency}\n\nStatement text:\n"""\n${text}\n"""`;
  return { system, user };
}

async function callLlmParse(cfg) {
  let up;
  try {
    up = await fetch(cfg.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 16000,
          stream: false,
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'system', content: cfg.system }, { role: 'user', content: cfg.user }],
        }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const e = new Error(`Could not reach LLM at ${cfg.baseUrl} — ${err.message}`);
    e.httpStatus = 502;
    throw e;
  }
  if (!up.ok) {
    let detail = '';
    try { detail = (await up.text()).slice(0, 300); } catch (err) { /* ignore */ }
    const e = new Error(`LLM returned HTTP ${up.status}: ${detail}`);
    e.httpStatus = 502;
    throw e;
  }
  const body = await up.json().catch(() => null);
  const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return extractJson(content);
}

let dataCache = null;
function invalidateDataCache() { dataCache = null; }

function loadData() {
  let stat;
  try {
    stat = fs.statSync(DATA_FILE);
  } catch (err) {
    return defaultData();
  }
  if (dataCache && dataCache.mtimeMs === stat.mtimeMs && dataCache.size === stat.size) {
    return dataCache.data;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const data = normalizeData(parsed);
    dataCache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch (err) {
    return defaultData();
  }
}

function saveData(data) {
  // Atomic write: write to a temp file then rename over the target so a crash
  // mid-write can never leave a half-written / corrupt data.json.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  invalidateDataCache();
}

// Serialize all writes so concurrent saves can't interleave and corrupt the file.
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  const run = writeQueue.then(task);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const base = { 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { ...base, 'Content-Length': body.length });
    res.end(body);
    return;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...base, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function instanceStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Instance files are named "<optional name> YYYY-MM-DD_HH-mm-ss.json"
function parseInstanceFile(file) {
  const m = file.match(/^(.*)?(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.json$/);
  if (!m) return null;
  return { file, name: (m[1] || '').trim(), created: m[2] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/data' && req.method === 'GET') {
    return send(res, 200, loadData());
  }

  if (pathname === '/api/data' && req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status === 413 ? 413 : 400, { ok: false, error: 'Invalid data' });
    }
    let data;
    try {
      const parsed = JSON.parse(raw || '{}');
      // Validate + normalize server-side. Anything malformed is dropped rather
      // than trusted, so a tampered or buggy client can't corrupt data.json.
      data = normalizeData(parsed);
    } catch (err) {
      return send(res, 400, { ok: false, error: 'Invalid data' });
    }
    try {
      await enqueueWrite(() => saveData(data));
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 500, { ok: false, error: 'Could not save' });
    }
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    try {
      await enqueueWrite(() => saveData(defaultData()));
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 500, { ok: false, error: 'Could not reset' });
    }
  }

  if (pathname === '/api/exit' && req.method === 'POST') {
    send(res, 200, { ok: true });
    setTimeout(() => {
      process.exit(0);
    }, 100);
    return;
  }

  if (pathname === '/api/backup' && req.method === 'POST') {
    try {
      let createdFile = '';
      await enqueueWrite(() => {
        const data = loadData();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUPS_DIR, `moneywala-backup-${timestamp}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');
        createdFile = path.basename(backupFile);
      });
      const backups = fs.readdirSync(BACKUPS_DIR)
        .filter((f) => f.startsWith('moneywala-backup-') && f.endsWith('.json'))
        .map((f) => ({ file: f, path: `backups/${f}` }))
        .sort((a, b) => b.file.localeCompare(a.file));
      for (const stale of backups.slice(MAX_BACKUPS)) {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, stale.file)); } catch (err) { /* ignore */ }
      }
      return send(res, 200, { ok: true, file: createdFile, backups: backups.slice(0, MAX_BACKUPS) });
    } catch (err) {
      return send(res, 500, { ok: false, error: 'Could not create backup' });
    }
  }

  if (pathname.startsWith('/api/backups/') && req.method === 'GET') {
    const filename = pathname.replace('/api/backups/', '');
    const safeFile = path.basename(filename);
    if (safeFile && safeFile.startsWith('moneywala-backup-') && safeFile.endsWith('.json')) {
      const filePath = path.join(BACKUPS_DIR, safeFile);
      return fs.readFile(filePath, 'utf8', (err, content) => {
        if (err) return send(res, 404, { ok: false, error: 'Backup not found' });
        try {
          return send(res, 200, JSON.parse(content));
        } catch (parseErr) {
          return send(res, 500, { ok: false, error: 'Backup is corrupted' });
        }
      });
    }
    return send(res, 400, { ok: false, error: 'Invalid backup file' });
  }

  if (pathname === '/api/instances' && req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status === 413 ? 413 : 400, { ok: false, error: 'Invalid request' });
    }
    let name = '';
    try {
      const parsed = JSON.parse(raw || '{}');
      name = String(parsed.name || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    } catch (err) {
      return send(res, 400, { ok: false, error: 'Invalid request' });
    }
    try {
      let createdFile = '';
      let createdStamp = '';
      await enqueueWrite(() => {
        const data = loadData();
        const stamp = instanceStamp();
        let base = name ? `${name} ${stamp}` : stamp;
        let i = 1;
        while (fs.existsSync(path.join(INSTANCES_DIR, `${base}.json`))) {
          base = name ? `${name} (${i}) ${stamp}` : `(${i}) ${stamp}`;
          i++;
        }
        createdFile = `${base}.json`;
        createdStamp = stamp;
        fs.writeFileSync(path.join(INSTANCES_DIR, createdFile), JSON.stringify(data, null, 2), 'utf8');
      });
      return send(res, 200, { ok: true, file: createdFile, name, created: createdStamp });
    } catch (err) {
      return send(res, 500, { ok: false, error: 'Could not save instance' });
    }
  }

  if (pathname === '/api/instances' && req.method === 'GET') {
    try {
      const instances = fs.readdirSync(INSTANCES_DIR)
        .map(parseInstanceFile)
        .filter(Boolean)
        .sort((a, b) => b.created.localeCompare(a.created) || b.file.localeCompare(a.file));
      return send(res, 200, { ok: true, instances });
    } catch (err) {
      return send(res, 500, { ok: false, error: 'Could not list instances' });
    }
  }

  if (pathname.startsWith('/api/instances/') && req.method === 'GET') {
    let filename = '';
    try {
      filename = decodeURIComponent(pathname.replace('/api/instances/', ''));
    } catch (err) {
      return send(res, 400, { ok: false, error: 'Invalid instance file' });
    }
    const safeFile = path.basename(filename);
    if (safeFile && parseInstanceFile(safeFile)) {
      try {
        const raw = fs.readFileSync(path.join(INSTANCES_DIR, safeFile), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch (err) {
        return send(res, 404, { ok: false, error: 'Instance not found' });
      }
    }
    return send(res, 400, { ok: false, error: 'Invalid instance file' });
  }

  if (pathname === '/api/import/test' && req.method === 'POST') {
    const data = loadData();
    const { baseUrl, model, timeoutMs } = data.settings.llm;
    let up;
    try {
      up = await fetch(baseUrl + '/v1/models', { signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)) });
    } catch (err) {
      return send(res, 502, { ok: false, error: `Could not reach LLM at ${baseUrl} — ${err.message}` });
    }
    if (!up.ok) return send(res, 502, { ok: false, error: `LLM endpoint returned HTTP ${up.status}` });
    let models = [];
    try {
      const body = await up.json();
      if (body && Array.isArray(body.data)) models = body.data.map((m) => m.id).filter(Boolean);
    } catch (err) { /* reachable but non-JSON body — still fine */ }
    return send(res, 200, { ok: true, models, model, hasModel: models.length === 0 || models.includes(model) });
  }

  if (pathname === '/api/import/parse' && req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status === 413 ? 413 : 400, { ok: false, error: 'Payload too large' });
    }
    let text;
    try {
      const body = JSON.parse(raw || '{}');
      text = typeof body.text === 'string' ? body.text.trim() : '';
    } catch (err) {
      return send(res, 400, { ok: false, error: 'Invalid body' });
    }
    if (!text) return send(res, 400, { ok: false, error: 'No statement text provided' });

    const data = loadData();
    const { baseUrl, model, timeoutMs } = data.settings.llm;
    const categories = data.categories;
    const truncated = text.length > IMPORT_TEXT_LIMIT;
    if (truncated) text = text.slice(0, IMPORT_TEXT_LIMIT);
    const chunks = chunkText(text);

    const started = Date.now();
    const allTxns = [];
    const periods = [];
    let statement = { kind: 'unknown', period: '', account: '' };
    const failed = [];
    const year = yearHint(text);
    for (let i = 0; i < chunks.length; i++) {
      try {
        const ctx = [];
        if (chunks.length > 1) ctx.push(`- This text is part ${i + 1} of ${chunks.length} of a longer statement. Parse only the rows present in this part; do not guess about other parts.`);
        if (i > 0) ctx.push(`- Known statement context: kind=${statement.kind}; period=${statement.period || 'unknown'}; account=${statement.account || 'unknown'}. Use this to resolve missing years/details.`);
        if (year) ctx.push(`- Explicit years found in the statement: ${year}. Prefer this year when the text omits one.`);
        else ctx.push(`- No explicit year appears in the text. If nothing else indicates the year, use the current year (${new Date().getFullYear()}).`);
        const { system, user } = buildParsePrompt(chunks[i], categories, data.currency, ctx);
        const perChunkMs = Math.max(timeoutMs, 300000 + chunks[i].length * 75);
        const result = await callLlmParse({ baseUrl, model, timeoutMs: perChunkMs, system, user });
        allTxns.push(...normalizeImportedTxns(result.transactions, categories));
        if (result.statement && typeof result.statement === 'object') {
          const k = ['bank', 'credit_card', 'unknown'].includes(result.statement.kind) ? result.statement.kind : 'unknown';
          if (statement.kind === 'unknown' && k !== 'unknown') statement.kind = k;
          const p = stringField(result.statement.period).slice(0, 60);
          if (p && !periods.includes(p)) periods.push(p);
          const a = stringField(result.statement.account).slice(0, 60);
          if (!statement.account && a) statement.account = a;
        }
      } catch (err) {
        failed.push({ chunk: i + 1, error: (err && err.message) || String(err) });
      }
    }
    if (failed.length === chunks.length) {
      return send(res, 502, { ok: false, error: failed[0].error });
    }
    if (periods.length === 1) statement.period = periods[0];
    else if (periods.length > 1) statement.period = periods[0] + ' … ' + periods[periods.length - 1];
    const seen = new Set();
    const transactions = allTxns.filter((t) => {
      const key = [t.date, t.amount, (t.description || '').toLowerCase()].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return send(res, 200, {
      ok: true,
      statement,
      transactions,
      truncated,
      chunks: chunks.length,
      partial: failed.length > 0,
      failedChunks: failed.map((f) => f.chunk),
      failedErrors: failed.map((f) => f.error),
      model,
      ms: Date.now() - started,
    });
  }

  if (pathname.startsWith('/backups/') && req.method === 'GET') {
    const filename = pathname.replace('/backups/', '');
    const safeFile = path.basename(filename);
    if (safeFile && safeFile.startsWith('moneywala-backup-') && safeFile.endsWith('.json')) {
      const filePath = path.join(BACKUPS_DIR, safeFile);
      return fs.readFile(filePath, (err, content) => {
        if (err) return send(res, 404, 'Not found', CONTENT_TYPES['.html']);
        return send(res, 200, content, 'application/json; charset=utf-8');
      });
    }
    return send(res, 400, 'Invalid backup file', CONTENT_TYPES['.html']);
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, pathname.replace(/\/+$/, '') || '/index.html');
  if (pathname === '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        send(res, 200, fallback, CONTENT_TYPES['.html']);
      });
      return;
    }
    send(res, 200, content, CONTENT_TYPES[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  MoneyWala is running at http://localhost:${PORT}`);
  console.log(`  (bound to localhost only)\n  Press Ctrl+C to stop.\n`);
});
