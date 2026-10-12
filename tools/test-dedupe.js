// Verify the Phase-3 helpers (normText, textTokens, findDuplicate, dedupeRows)
// by pulling their real source out of app.js and running them against a mocked state.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function grab(fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error('not found: ' + fnName);
  // walk braces to the end of this top-level function
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, j + 1);
}

const code = ['normText', 'textTokens', 'findDuplicate', 'dedupeRows'].map(grab).join('\n');
let state = null;
const factory = new Function('stateRef', `${code}; return { normText, textTokens, findDuplicate, dedupeRows };`);

// --- harness with mutable state ---
function run(stateVal) {
  state = stateVal;
  const F = factory(() => state);
  // findDuplicate reads the free variable `state`; rebind via closure trick
  return F;
}
// findDuplicate references the global-ish `state`; provide it via a wrapper scope:
const sandbox = (stateVal) => {
  state = stateVal;
  return eval(`(function(){ ${code}; return { normText, textTokens, findDuplicate, dedupeRows }; })()`);
};

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
}

// normText
const n = sandbox({ expenses: [], income: [] });
eq('normText lowercases+compacts', n.normText('  ROGER  S-COFFEE!! '), 'roger s coffee');
eq('normText empty', n.normText(''), '');

// textTokens drops <3 chars
eq('textTokens filters short', [...n.textTokens('a b cde f ghh')].sort(), ['cde', 'ghh']);

// findDuplicate: exact-ish match in expenses
{
  const S = {
    expenses: [{ date: '2026-07-02', description: 'ROGER S COFFEE', amount: 6.4, source: '' }],
    income: [],
  };
  const F = sandbox(S);
  const hit = F.findDuplicate({ date: '2026-07-02', description: 'ROGER S COFFEE', amount: 6.4, type: 'expense' });
  eq('findDuplicate finds match', !!hit, true);
  eq('findDuplicate returns amount', hit && hit.amount, 6.4);
}
// findDuplicate: different amount -> null
{
  const S = { expenses: [{ date: '2026-07-02', description: 'ROGER S COFFEE', amount: 6.4 }], income: [] };
  const F = sandbox(S);
  eq('findDuplicate rejects different amount', F.findDuplicate({ date: '2026-07-02', description: 'ROGER S COFFEE', amount: 99, type: 'expense' }), null);
}
// findDuplicate: income row checks income list
{
  const S = {
    expenses: [{ date: '2026-07-09', description: 'SALARY', amount: 2450 }],
    income: [{ date: '2026-07-09', description: 'DIRECT DEPOSIT SALARY', amount: 2450, source: '' }],
  };
  const F = sandbox(S);
  eq('findDuplicate income checks income list', !!F.findDuplicate({ date: '2026-07-09', description: 'DIRECT DEPOSIT SALARY', amount: 2450, type: 'income' }), true);
  eq('findDuplicate expense type checks expense list', !!F.findDuplicate({ date: '2026-07-09', description: 'DIRECT DEPOSIT SALARY', amount: 2450, type: 'expense' }), true);
}
// dedupeRows: merge identical, keep higher confidence
{
  const F = sandbox({ expenses: [], income: [] });
  const rows = [
    { date: '2026-07-02', description: 'NETFLIX.COM', amount: 15.99, confidence: 0.9, type: 'expense' },
    { date: '2026-07-02', description: 'netflix .com', amount: 15.99, confidence: 0.7, type: 'expense' },
    { date: '2026-07-04', description: 'SHELL', amount: 58.23, confidence: 0.8, type: 'expense' },
  ];
  const out = F.dedupeRows(rows);
  eq('dedupeRows merges dupes', out.length, 2);
  const nf = out.find(r => /netflix/i.test(r.description));
  eq('dedupeRows keeps higher confidence', nf.confidence, 0.9);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
