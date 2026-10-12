/* MoneyWala — frontend logic (vanilla JS, no dependencies) */

const CATEGORY_PALETTE = [
  '#4f9dff', '#35d0a1', '#ffb648', '#ff7a59', '#b980ff',
  '#ff6fb1', '#4dd6c4', '#ffd24a', '#7c9cff', '#f068a1',
  '#6fcf97', '#f2994a', '#56ccf2', '#e056a3',
];

const DEFAULT_CATEGORIES = [
  'Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Fuel',
  'Healthcare', 'Entertainment', 'Clothing', 'Debt', 'Insurance',
  'Maintenance', 'Personal', 'Other', 'Savings',
];

function defaultSettings() {
  return {
    llm: { baseUrl: 'http://127.0.0.1:8080', model: 'qwen3.8:27b-q4_K_M', timeoutMs: 300000 },
    import: { confidenceThreshold: 0.85 },
  };
}

const state = {
  expenses: [],
  income: [],
  budgets: [],
  savingsGoals: [],
  debts: [],
  accounts: [],
  recurringTemplates: [],
  settings: defaultSettings(),
  importQueue: [],
  importedStatements: [],
  currency: '$',
  categories: [...DEFAULT_CATEGORIES],
  alertsShown: {},
};

// A goal-linked expense is a transfer into a savings goal, not real spending.
function isTransfer(x) { return !!(x && x.goalId); }

let saveTimer = null;
let saveStatus = 'saved';
let editingIncId = null;
let expSearchText = '';
let incSearchText = '';

/* ---------- helpers ---------- */
function fmt(n) {
  const v = Number(n || 0);
  return state.currency + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShort(n) {
  const v = Number(n || 0);
  const s = state.currency + Math.round(v).toLocaleString('en-US');
  return s;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function dateStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function today() { return dateStr(new Date()); }
function ym(d) { return (d || '').slice(0, 7); }
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ymStr, short) {
  const s = String(ymStr || '');
  const m = Number(s.slice(5, 7));
  const y = s.slice(0, 4);
  const name = (m >= 1 && m <= 12) ? MONTH_NAMES[m - 1] : s;
  return short ? `${name} '${y.slice(2)}` : `${name} ${y}`;
}

let undoActive = false;

function toast(msg, isError, action) {
  const t = document.getElementById('toast');
  if (!action && !isError && undoActive) return;
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(t._t);
      undoActive = false;
      action.fn();
    });
    t.appendChild(btn);
    undoActive = true;
  }
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => {
    t.classList.add('hidden');
    undoActive = false;
  }, action ? 10000 : 2600);
}

function showUndo(message, restoreFn, historyId) {
  toast(message, false, {
    label: 'Undo',
    fn: () => {
      if (historyId) commitHistory(historyId);
      else restoreFn();
      toast('Restored ✓');
    },
  });
}

/* ---------- history / change tracking ---------- */
let history = [];
const HISTORY_LIMIT = 100;

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

function recordChange(type, description, undo) {
  history.unshift({ id: uid(), timestamp: Date.now(), type, description, undo });
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  renderHistory();
  return history[0].id;
}

function commitHistory(id) {
  const idx = history.findIndex(h => h.id === id);
  if (idx === -1) return false;
  const item = history[idx];
  history.splice(idx, 1);
  try { item.undo(); } catch (e) {}
  renderHistory();
  return true;
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  if (!history.length) {
    list.innerHTML = `<li class="empty">No changes recorded yet.</li>`;
    return;
  }
  list.innerHTML = history.map(h => `
    <li>
      <div class="hist-main">
        <span class="hist-type">${escapeHtml(h.type)}</span>
        <span class="hist-desc">${escapeHtml(h.description)}</span>
        <span class="hist-time">${timeAgo(h.timestamp)}</span>
      </div>
      <button class="primary-sm" data-undo-hist="${h.id}">Undo</button>
    </li>`).join('');
}

const histListEl = document.getElementById('historyList');
if (histListEl) {
  histListEl.addEventListener('click', (e) => {
    const id = e.target.getAttribute('data-undo-hist');
    if (!id) return;
    if (commitHistory(id)) toast('Change undone ✓');
  });
}

/* ---------- dashboard period ---------- */
let dashFrom = '';
let dashTo = '';

function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function rangeForPreset(preset) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === 'month') return [new Date(y, m, 1), new Date(y, m + 1, 0)];
  if (preset === 'lastMonth') return [new Date(y, m - 1, 1), new Date(y, m - 1, 0)];
  if (preset === 'quarter') return [new Date(y, m - 2, 1), new Date(y, m, 0)];
  if (preset === 'year') return [new Date(y, 0, 1), new Date(y, 11, 31)];
  return [null, null];
}

function periodText() {
  if (!dashFrom && !dashTo) return 'all time';
  const f = dashFrom;
  const t = dashTo || dashFrom;
  if (f.slice(0, 7) === t.slice(0, 7)) return monthLabel(f.slice(0, 7));
  return monthLabel(f.slice(0, 7)) + ' – ' + monthLabel(t.slice(0, 7));
}

function inDashPeriod(date) {
  const d = String(date || '').slice(0, 10);
  if (!d) return false;
  if (dashFrom && d < dashFrom) return false;
  if (dashTo && d > dashTo) return false;
  return true;
}

function setDashPreset(preset) {
  const [from, to] = rangeForPreset(preset);
  dashFrom = from ? isoDate(from) : '';
  dashTo = to ? isoDate(to) : '';
  const f = document.getElementById('dashFrom');
  const t = document.getElementById('dashTo');
  if (f) f.value = dashFrom;
  if (t) t.value = dashTo;
  document.querySelectorAll('#dashboard .chip').forEach(c => c.classList.toggle('active', c.dataset.preset === preset));
  renderDashboard();
}

/* ---------- income chart period ---------- */
let incChartFrom = '';
let incChartTo = '';

function inIncChartPeriod(date) {
  if (!incChartFrom && !incChartTo) return true;
  const d = String(date || '').slice(0, 10);
  if (!d) return false;
  if (incChartFrom && d < incChartFrom) return false;
  if (incChartTo && d > incChartTo) return false;
  return true;
}

function setIncChartPreset(preset) {
  const [from, to] = rangeForPreset(preset);
  incChartFrom = from ? isoDate(from) : '';
  incChartTo = to ? isoDate(to) : '';
  const f = document.getElementById('incChartFrom');
  const t = document.getElementById('incChartTo');
  if (f) f.value = incChartFrom;
  if (t) t.value = incChartTo;
  document.querySelectorAll('#income .chip[data-preset]').forEach(c => c.classList.toggle('active', c.dataset.preset === preset));
  renderIncome();
}

/* ---------- data persistence ---------- */
async function loadData() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  Object.assign(state, data);
  seedAndMigrate();
  state.alertsShown = state.alertsShown || {};
  document.getElementById('currencySelect').value = state.currency || '$';
}

function templateFromTransaction(kind, t) {
  const base = { kind, id: t.id, category: t.category, source: t.source, amount: t.amount, date: t.date };
  if (kind === 'expense') return { ...base, type: 'expense', category: t.category, description: t.description || '', goalId: t.goalId || null, tags: t.tags || [], notes: t.notes || '', frequency: t.recurring };
  return { ...base, type: 'income', source: t.source, description: t.description || '', tags: t.tags || [], notes: t.notes || '', frequency: t.recurring };
}

// Keep the originating (first) transaction in the ledger and mirror its recurring
// pattern as a template so upcoming occurrences can be projected without persisting them.
function recordRecurringTemplate(kind, t) {
  if (!t || !t.recurring) return;
  const existing = state.recurringTemplates.find(x => x.id === t.id);
  if (existing) { existing.frequency = t.recurring; return; }
  state.recurringTemplates.push(templateFromTransaction(kind, t));
}

const FIXED_CATEGORY_KEYWORDS = ['rent','utility','electric','water','gas','internet','phone','insurance','loan','mortgage','subscription','wifi'];
function isFixedCategory(cat) {
  const c = (cat || '').toLowerCase();
  return FIXED_CATEGORY_KEYWORDS.some(k => c.includes(k));
}

// Project the next `count` occurrences of a template from its start date.
function projectUpcoming(days) {
  const now = Date.now();
  const end = now + days * 86400000;
  let spending = 0, income = 0, count = 0;
  state.recurringTemplates.forEach(t => {
    if (!t.frequency || !t.amount) return;
    const amt = Number(t.amount) || 0;
    // Skip the first occurrence if it already exists as a real transaction.
    let occurrences = projectOccurrences(t, 12);
    const baseDate = new Date(t.date + 'T00:00:00').getTime();
    occurrences = occurrences.filter(d => {
      const ts = new Date(d + 'T00:00:00').getTime();
      if (ts < baseDate) return false; // before template start
      if (ts <= now) return false;     // already happened
      if (ts > end) return false;      // beyond window
      return true;
    });
    for (const d of occurrences) { count += 1; if (t.type === 'income') income += amt; else spending += amt; }
  });
  return { spending, income, count };
}

// Return the next `n` dates a template would fire, starting after its start date.
function projectOccurrences(t, n) {
  const out = [];
  let d = new Date(t.date + 'T00:00:00');
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      if (t.frequency === 'monthly') d = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate());
      else if (t.frequency === 'yearly') d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
      else if (t.frequency === 'biweekly') d = new Date(d.getTime() + 14 * 86400000);
      else if (t.frequency === 'weekly') d = new Date(d.getTime() + 7 * 86400000);
      else if (t.frequency === 'daily') d = new Date(d.getTime() + 86400000);
    }
    out.push(dateStr(d));
  }
  return out;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveStatus = 'saving';
  updateSaveIndicator();
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      saveStatus = 'saved';
    } catch {
      saveStatus = 'error';
    }
    updateSaveIndicator();
  }, 400);
}

// If the page is closed/reloaded while a save is still debounced, flush it
// synchronously so the last change is not lost.
window.addEventListener('pagehide', () => {
  if (saveStatus !== 'saving') return;
  clearTimeout(saveTimer);
  try {
    fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
      keepalive: true,
    });
  } catch { /* best effort */ }
});

function updateSaveIndicator() {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.className = 'save-status ' + saveStatus;
  if (saveStatus === 'saved') el.textContent = '●';
  else if (saveStatus === 'saving') el.textContent = '◌';
  else el.textContent = '⚠';
}

/* ---------- tabs ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.classList.add('active');
  document.getElementById(name).classList.add('active');
  render();
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
document.getElementById('historyMenuBtn').addEventListener('click', () => {
  const menu = document.getElementById('optionsMenu');
  const overlay = document.getElementById('menuOverlay');
  if (menu) menu.classList.add('hidden');
  if (overlay) overlay.classList.add('hidden');
  switchTab('history');
});

/* ---------- dashboard period filter ---------- */
document.querySelectorAll('#dashboard .chip[data-preset]').forEach(c => {
  c.addEventListener('click', () => setDashPreset(c.dataset.preset));
});
['dashFrom', 'dashTo'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    dashFrom = document.getElementById('dashFrom').value;
    dashTo = document.getElementById('dashTo').value;
    document.querySelectorAll('#dashboard .chip').forEach(c => c.classList.remove('active'));
    renderDashboard();
  });
});

/* ---------- income chart period filter ---------- */
document.querySelectorAll('#income .chip[data-preset]').forEach(c => {
  c.addEventListener('click', () => setIncChartPreset(c.dataset.preset));
});
['incChartFrom', 'incChartTo'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    incChartFrom = document.getElementById('incChartFrom').value;
    incChartTo = document.getElementById('incChartTo').value;
    document.querySelectorAll('#income .chip').forEach(c => c.classList.remove('active'));
    renderIncome();
  });
});

/* ---------- currency ---------- */
document.getElementById('currencySelect').addEventListener('change', (e) => {
  const oldCurrency = state.currency;
  state.currency = e.target.value;
  scheduleSave();
  render();
  if (state.currency !== oldCurrency) recordChange('Currency changed', `${oldCurrency} → ${state.currency}`, () => { state.currency = oldCurrency; scheduleSave(); render(); });
});

/* ---------- category options ---------- */
function populateCategorySelects() {
  const cats = state.categories.length ? state.categories : DEFAULT_CATEGORIES;
  ['expCategory', 'budgetCategory'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (current) sel.value = current;
  });
}

/* ---------- expenses ---------- */
function applyToGoal(exp, delta) {
  if (!exp.goalId || !delta) return;
  const g = state.savingsGoals.find(x => x.id === exp.goalId);
  if (!g) return;
  g.current = Math.max(0, (Number(g.current) || 0) + delta);
}

function populateGoalSelect() {
  const sel = document.getElementById('expGoal');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">No goal</option>` +
    state.savingsGoals.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  if (current) sel.value = current;
}

function populateAccountSelect() {
  const sel = document.getElementById('expAccount');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">No account</option>` +
    state.accounts.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
  if (current) sel.value = current;
}

function toggleGoalField() {
  const catEl = document.getElementById('expCategory');
  const field = document.getElementById('expGoalField');
  if (!catEl || !field) return;
  const isSavings = catEl.value === 'Savings';
  field.classList.toggle('hidden', !isSavings);
  if (!isSavings) {
    const sel = document.getElementById('expGoal');
    if (sel) sel.value = '';
  }
}

document.getElementById('expenseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category = document.getElementById('expCategory').value;
  const isSavings = category === 'Savings';
  const goalId = isSavings ? (document.getElementById('expGoal').value || null) : null;
  const goal = goalId ? state.savingsGoals.find(g => g.id === goalId) : null;
  const tagsRaw = document.getElementById('expTags').value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const notes = document.getElementById('expNotes').value.trim();
  const recurring = document.getElementById('expRecurring').value || null;
  const account = document.getElementById('expAccount')?.value || null;
  const exp = {
    id: uid(),
    date: document.getElementById('expDate').value,
    amount,
    category,
    description: document.getElementById('expDesc').value.trim(),
    goalId: goal ? goal.id : null,
    goalName: goal ? goal.name : null,
    tags,
    notes,
    recurring,
    account,
  };
  if (document.getElementById('expSplitToggle')?.checked) {
    const rows = [...document.querySelectorAll('#expSplitRows .split-row')];
    let sum = 0;
    const items = rows.map(r => ({
      category: r.querySelector('.cat').value,
      description: r.querySelector('.desc').value.trim(),
      amount: parseFloat(r.querySelector('.amt').value),
    }));
    if (!items.length || items.some(i => !i.amount || i.amount <= 0)) return toast('Add at least one valid split item', true);
    sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    if (Math.round(sum * 100) !== Math.round(amount * 100)) {
      return toast(`Split items must total ${fmt(amount)} (currently ${fmt(sum)})`, true);
    }
    const groupId = uid();
    exp.groupId = groupId;
    state.expenses.push(exp);
    recordRecurringTemplate('expense', exp);
    if (goal) goal.current = (Number(goal.current) || 0) + amount;
    items.forEach(i => state.expenses.push({
      id: uid(), groupId, _splitChild: true, date: exp.date, category: i.category || category,
      description: i.description || '', amount: i.amount, tags, notes, account, recurring, goalId: null, goalName: null,
    }));
  } else {
    state.expenses.push(exp);
    recordRecurringTemplate('expense', exp);
    if (goal) goal.current = (Number(goal.current) || 0) + amount;
  }
  e.target.reset();
  document.getElementById('expDate').value = today();
  toggleGoalField();
  if (recurring) toast(`Recurring ${recurring} expense created — upcoming occurrences are projected, not yet added`);
  scheduleSave();
  render();
  checkBudgetAlerts();
  if (goal) toast(`${fmt(amount)} added to the ${goal.name} goal`);
});

document.getElementById('expCategory').addEventListener('change', toggleGoalField);

/* ---------- expense split rows ---------- */
function addSplitRow() {
  const container = document.getElementById('expSplitRows');
  const row = document.createElement('div');
  row.className = 'split-row';
  row.innerHTML = `<select class="cat"></select><input class="desc" placeholder="Line item" /><input type="number" step="0.01" min="0.01" class="amt" /><button type="button" class="del-split">✕</button>`;
  const del = row.querySelector('.del-split');
  del.addEventListener('click', () => { row.remove(); refreshSplitCategorySelects(); });
  container.appendChild(row);
  refreshSplitCategorySelects();
}

function refreshSplitCategorySelects() {
  const cats = state.categories.length ? state.categories : DEFAULT_CATEGORIES;
  document.querySelectorAll('#expSplitRows .cat').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = '<option value="">Category</option>' + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (current) sel.value = current;
  });
}

document.getElementById('expSplitToggle').addEventListener('change', () => {
  const checked = document.getElementById('expSplitToggle').checked;
  const container = document.getElementById('expSplitRows');
  if (checked && !container.children.length) { addSplitRow(); addSplitRow(); }
  else if (!checked) { container.innerHTML = ''; }
});



function deleteExpense(id) {
  const exp = state.expenses.find(x => x.id === id);
  if (!exp) return;
  const members = exp.groupId ? state.expenses.filter(x => x.groupId === exp.groupId) : [exp];
  members.forEach(m => { state.expenses = state.expenses.filter(x => x.id !== m.id); applyToGoal(m, -m.amount); });
  const removedTemplates = state.recurringTemplates.filter(t => members.some(m => t.id === m.id));
  state.recurringTemplates = state.recurringTemplates.filter(t => !members.some(m => t.id === m.id));
  scheduleSave();
  render();
  checkBudgetAlerts();
  const restore = () => {
    members.forEach(m => { state.expenses.push(m); if (m.goalId) applyToGoal(m, m.amount); });
    if (removedTemplates.length) state.recurringTemplates.push(...removedTemplates);
    scheduleSave();
    render();
  };
  showUndo(exp.goalId ? 'Expense deleted — also removed from its goal' : 'Expense deleted', restore, recordChange('Expense deleted', `${exp.category} — ${fmt(exp.amount)}`, restore));
}

function renderExpenses() {
  const filter = document.getElementById('expMonthFilter').value;
  const search = (document.getElementById('expSearch')?.value || '').toLowerCase();
  const tbody = document.querySelector('#expensesTable tbody');
  let list = [...state.expenses].filter(x => !x._splitChild).sort((a, b) => b.date.localeCompare(a.date));
  if (filter) list = list.filter(x => ym(x.date) === filter);
  if (search) {
    list = list.filter(x =>
      (x.category || '').toLowerCase().includes(search) ||
      (x.description || '').toLowerCase().includes(search) ||
      (x.tags || []).some(t => t.toLowerCase().includes(search)) ||
      (x.notes || '').toLowerCase().includes(search)
    );
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No expenses yet.</td></tr>`;
  } else {
    tbody.innerHTML = list.map(x => {
      const isEditing = editingExpId === x.id;
      const recurringBadge = x.recurring ? `<span class="recurring-badge" title="Recurring: ${x.recurring}">↻ ${x.recurring}</span>` : '';
      const tagsHtml = (x.tags || []).length ? `<div class="tx-tags">${x.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
      const notesHtml = x.notes ? `<div class="tx-notes" title="${escapeHtml(x.notes)}">📝 ${escapeHtml(x.notes).slice(0, 40)}${x.notes.length > 40 ? '...' : ''}</div>` : '';
      return `
      <tr data-exp-id="${x.id}">
        <td>${x.date}</td>
        <td>${x.category}${recurringBadge}</td>
        <td>${escapeHtml(x.description) || '—'}${x.goalName ? ` <span class="goal-tag transfer" title="Transfer into the ${escapeHtml(x.goalName)} goal — not counted as spending">→ ${escapeHtml(x.goalName)}</span>` : ''}${tagsHtml}${notesHtml}</td>
         <td class="num amount-cell" data-edit-exp="${x.id}">
          ${isEditing ? `<input type="number" step="0.01" min="0.01" value="${x.amount}" id="expEdit-${x.id}" style="width:70px;" /> <button data-save-exp="${x.id}" class="primary-sm">✓</button>` : `${fmt(x.amount)}`}
         </td>
        <td class="num"><button class="del-btn" data-del-exp="${x.id}" title="Delete">✕</button></td>
      </tr>`;
    }).join('');
  }
  renderCategoryChart('expCategoryChart', expensesByCategory(filter));
}

document.getElementById('expMonthFilter').addEventListener('change', renderExpenses);
document.getElementById('expSearch').addEventListener('input', renderExpenses);
document.getElementById('expensesTable').addEventListener('click', (e) => {
  const saveId = e.target.getAttribute('data-save-exp');
  if (saveId) {
    const exp = state.expenses.find(x => x.id === saveId);
    if (!exp) return;
    const newAmount = parseFloat(document.getElementById(`expEdit-${saveId}`).value);
    if (isNaN(newAmount) || newAmount <= 0) return;
    const diff = newAmount - exp.amount;
    const oldAmount = exp.amount;
    exp.amount = newAmount;
    if (exp.goalId) applyToGoal(exp, diff);
    editingExpId = null;
    scheduleSave();
    render();
    checkBudgetAlerts();
    if (diff !== 0) {
      const restore = () => {
        exp.amount -= diff;
        if (exp.goalId) applyToGoal(exp, -diff);
        scheduleSave();
        render();
        checkBudgetAlerts();
      };
      recordChange('Amount changed', `${exp.category} — ${fmt(oldAmount)} → ${fmt(newAmount)}`, restore);
    }
    return;
  }
  const editId = e.target.getAttribute('data-edit-exp');
  if (editId) {
    editingExpId = editId;
    render();
    return;
  }
  const id = e.target.getAttribute('data-del-exp');
  if (id) deleteExpense(id);
});
document.getElementById('clearExpenses').addEventListener('click', () => {
  const removed = state.expenses;
  if (!removed.length) return;
  if (!confirm('Delete ALL expenses?')) return;
  state.expenses = [];
  removed.forEach(exp => applyToGoal(exp, -exp.amount));
  const removedTemplates = state.recurringTemplates.filter(t => t.type === 'expense');
  state.recurringTemplates = state.recurringTemplates.filter(t => t.type !== 'expense');
  scheduleSave();
  render();
  const restore = () => {
    state.expenses = removed;
    removed.forEach(exp => applyToGoal(exp, exp.amount));
    if (removedTemplates.length) state.recurringTemplates.push(...removedTemplates);
    scheduleSave();
    render();
  };
  showUndo(`Deleted ${removed.length} expense${removed.length === 1 ? '' : 's'}`, restore, recordChange('Cleared expenses', `${removed.length} expense(s) deleted`, restore));
});

function expensesByCategory(month, pred) {
  const map = {};
  state.expenses.forEach(x => {
    if (x._splitChild) return; // split children are included in their master's amount
    if (isTransfer(x)) return; // goal-linked amounts are transfers, not spending
    if (pred ? !pred(x.date) : (month && ym(x.date) !== month)) return;
    map[x.category] = (map[x.category] || 0) + x.amount;
  });
  return map;
}

// Total spendable expense in the given predicate/range, excluding transfers.
function totalSpend(pred) {
  let sum = 0;
  state.expenses.forEach(x => { if (!x._splitChild && !isTransfer(x) && (!pred || pred(x.date))) sum += Number(x.amount) || 0; });
  return sum;
}
// Total transferred into savings goals in the given predicate/range.
function totalTransfers(pred) {
  let sum = 0;
  state.expenses.forEach(x => { if (!x._splitChild && isTransfer(x) && (!pred || pred(x.date))) sum += Number(x.amount) || 0; });
  return sum;
}

/* ---------- income ---------- */
document.getElementById('incomeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const tagsRaw = document.getElementById('incTags').value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const notes = document.getElementById('incNotes').value.trim();
  const recurring = document.getElementById('incRecurring').value || null;
  state.income.push({
    id: uid(),
    date: document.getElementById('incDate').value,
    amount: parseFloat(document.getElementById('incAmount').value),
    source: document.getElementById('incSource').value.trim(),
    tags,
    notes,
    recurring,
  });
  recordRecurringTemplate('income', state.income[state.income.length - 1]);
  e.target.reset();
  document.getElementById('incDate').value = today();
  if (recurring) toast(`Recurring ${recurring} income created — upcoming occurrences are projected, not yet added`);
  scheduleSave();
  render();
});

function deleteIncome(id) {
  const inc = state.income.find(x => x.id === id);
  if (!inc) return;
  state.income = state.income.filter(x => x.id !== id);
  const removedTemplates = state.recurringTemplates.filter(t => t.id === id);
  state.recurringTemplates = state.recurringTemplates.filter(t => t.id !== id);
  scheduleSave();
  render();
  const restore = () => {
    state.income.push(inc);
    if (removedTemplates.length) state.recurringTemplates.push(...removedTemplates);
    scheduleSave();
    render();
  };
  showUndo('Income deleted', restore, recordChange('Income deleted', `${inc.source} — ${fmt(inc.amount)}`, restore));
}

function renderIncome() {
  const filter = document.getElementById('incMonthFilter').value;
  const search = (document.getElementById('incSearch')?.value || '').toLowerCase();
  const tbody = document.querySelector('#incomeTable tbody');
  let list = [...state.income].sort((a, b) => b.date.localeCompare(a.date));
  if (filter) list = list.filter(x => ym(x.date) === filter);
  if (search) {
    list = list.filter(x =>
      (x.source || '').toLowerCase().includes(search) ||
      (x.tags || []).some(t => t.toLowerCase().includes(search)) ||
      (x.notes || '').toLowerCase().includes(search)
    );
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">No income recorded.</td></tr>`;
  } else {
    tbody.innerHTML = list.map(x => {
      const isEditing = editingIncId === x.id;
      const recurringBadge = x.recurring ? `<span class="recurring-badge" title="Recurring: ${x.recurring}">↻ ${x.recurring}</span>` : '';
      const tagsHtml = (x.tags || []).length ? `<div class="tx-tags">${x.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
      const notesHtml = x.notes ? `<div class="tx-notes" title="${escapeHtml(x.notes)}">📝 ${escapeHtml(x.notes).slice(0, 40)}${x.notes.length > 40 ? '...' : ''}</div>` : '';
      return `
      <tr data-inc-id="${x.id}">
        <td>${x.date}</td>
        <td>${escapeHtml(x.source)}${recurringBadge}</td>
        <td class="num amount-cell" data-edit-inc="${x.id}">
          ${isEditing ? `<input type="number" step="0.01" min="0.01" value="${x.amount}" id="incEdit-${x.id}" style="width:70px;" />` : `+${fmt(x.amount)}`}
        </td>
        <td>${tagsHtml}${notesHtml}</td>
        <td><button class="del-btn" data-del-inc="${x.id}" title="Delete">✕</button></td>
      </tr>`;
    }).join('');
  }
  const srcMap = {};
  state.income.forEach(x => { if (inIncChartPeriod(x.date)) srcMap[x.source] = (srcMap[x.source] || 0) + x.amount; });
  renderCategoryChart('incomeChart', srcMap);
}

document.getElementById('incMonthFilter').addEventListener('change', renderIncome);
document.getElementById('incomeTable').addEventListener('click', (e) => {
  const editId = e.target.getAttribute('data-edit-inc');
  if (editId) {
    editingIncId = editId;
    render();
    const inp = document.getElementById(`incEdit-${editId}`);
    if (inp) { inp.focus(); inp.select(); }
    return;
  }
  const id = e.target.getAttribute('data-del-inc');
  if (id) deleteIncome(id);
});
document.getElementById('incomeTable').addEventListener('focusout', (e) => {
  const idAttr = e.target.id;
  if (!idAttr || !idAttr.startsWith('incEdit-')) return;
  const id = idAttr.slice('incEdit-'.length);
  if (editingIncId !== id) return;
  editingIncId = null;
  const inc = state.income.find(x => x.id === id);
  const v = parseFloat(e.target.value);
  if (inc && !isNaN(v) && v > 0) {
    const oldAmount = inc.amount;
    inc.amount = v;
    scheduleSave();
    if (v !== oldAmount) {
      const restore = () => { inc.amount = oldAmount; scheduleSave(); render(); };
      recordChange('Income changed', `${inc.source} — ${fmt(oldAmount)} → ${fmt(v)}`, restore);
    }
  }
  render();
});
document.getElementById('clearIncome').addEventListener('click', () => {
  const removed = state.income;
  if (!removed.length) return;
  if (!confirm('Delete ALL income?')) return;
  state.income = [];
  const removedTemplates = state.recurringTemplates.filter(t => t.type === 'income');
  state.recurringTemplates = state.recurringTemplates.filter(t => t.type !== 'income');
  scheduleSave();
  render();
  const restore = () => {
    state.income = removed;
    if (removedTemplates.length) state.recurringTemplates.push(...removedTemplates);
    scheduleSave();
    render();
  };
  showUndo(`Deleted ${removed.length} income entr${removed.length === 1 ? 'y' : 'ies'}`, restore, recordChange('Cleared income', `${removed.length} income entr${removed.length === 1 ? 'y' : 'ies'} deleted`, restore));
});

/* ---------- budgets ---------- */
document.getElementById('budgetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cat = document.getElementById('budgetCategory').value;
  const amt = parseFloat(document.getElementById('budgetAmount').value);
  const existing = state.budgets.find(b => b.category === cat);
  if (existing) {
    const oldAmt = existing.amount;
    existing.amount = amt;
    scheduleSave();
    render();
    if (amt !== oldAmt) recordChange('Budget updated', `${cat} — ${fmt(oldAmt)} → ${fmt(amt)}`, () => { existing.amount = oldAmt; scheduleSave(); render(); });
  } else {
    const b = { id: uid(), category: cat, amount: amt };
    state.budgets.push(b);
    scheduleSave();
    render();
    recordChange('Budget added', `${cat} — ${fmt(amt)}`, () => { state.budgets = state.budgets.filter(x => x.id !== b.id); scheduleSave(); render(); });
  }
  e.target.reset();
});

function deleteBudget(id) {
  const b = state.budgets.find(x => x.id === id);
  if (!b) return;
  state.budgets = state.budgets.filter(x => x.id !== id);
  scheduleSave();
  render();
  const restore = () => { state.budgets.push(b); scheduleSave(); render(); };
  showUndo('Budget removed', restore, recordChange('Budget removed', `${b.category} — ${fmt(b.amount)}`, restore));
}

function renderBudgets() {
  const month = ym(today());
  const spent = expensesByCategory(month);
  const list = document.getElementById('budgetList');
  if (!state.budgets.length) {
    list.innerHTML = `<li class="empty">No budgets set. Pick a category and add a monthly limit.</li>`;
  } else {
    list.innerHTML = state.budgets.map(b => {
      const s = spent[b.category] || 0;
      const rawPct = b.amount ? (s / b.amount) * 100 : 0;
      const pct = Math.min(rawPct, 100);
      const bar = rawPct > 100 ? 'over' : rawPct > 85 ? 'warn' : '';
      return `
        <li>
          <span class="bl-name">${escapeHtml(b.category)}</span>
          <div class="progress"><div class="${bar}" style="width:${pct}%"></div></div>
          <span class="bl-amt">${fmt(s)} / ${fmt(b.amount)}</span>
          <button class="remove-budget" data-del-budget="${b.id}" title="Remove">✕</button>
        </li>`;
    }).join('');
  }
  renderBudgetChart();
}

document.getElementById('budgetList').addEventListener('click', (e) => {
  const id = e.target.getAttribute('data-del-budget');
  if (id) deleteBudget(id);
});

/* ---------- savings goals ---------- */
document.getElementById('savingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('goalName').value.trim();
  const target = parseFloat(document.getElementById('goalTarget').value);
  if (!name) return toast('Enter a goal name', true);
  if (isNaN(target) || target <= 0) return toast('Enter a valid target amount', true);
  const goal = {
    id: uid(),
    name,
    target,
    current: parseFloat(document.getElementById('goalStart').value) || 0,
    deadline: document.getElementById('goalDeadline').value || '',
    createdAt: today(),
  };
  state.savingsGoals.push(goal);
  e.target.reset();
  document.getElementById('goalStart').value = '0';
  scheduleSave();
  render();
  const desc = `${goal.name} — target ${fmt(goal.target)}${goal.current ? ` (${fmt(goal.current)} started)` : ''}`;
  recordChange('Goal added', desc, () => { state.savingsGoals = state.savingsGoals.filter(x => x.id !== goal.id); scheduleSave(); render(); });
});

function addSavings(id) {
  const inp = document.querySelector(`[data-add-goal="${id}"]`);
  const val = parseFloat(inp.value);
  if (!val || val <= 0) return toast('Enter an amount', true);
  const g = state.savingsGoals.find(g => g.id === id);
  const oldCurrent = g.current;
  g.current += val;
  inp.value = '';
  scheduleSave();
  render();
  recordChange('Added to goal', `${g.name} — ${fmt(oldCurrent)} → ${fmt(g.current)}`, () => { g.current = oldCurrent; scheduleSave(); render(); });
}

function removeSavings(id) {
  const g = state.savingsGoals.find(x => x.id === id);
  if (!g) return;
  state.savingsGoals = state.savingsGoals.filter(x => x.id !== id);
  scheduleSave();
  render();
  const restore = () => { state.savingsGoals.push(g); scheduleSave(); render(); };
  showUndo('Goal deleted', restore, recordChange('Goal deleted', `${g.name}`, restore));
}

let savingsSort = 'progress-desc';
let editingGoalId = null;
let editingExpId = null;

function goalPct(g) {
  return g.target ? Math.min((Number(g.current) || 0) / g.target, 1) : 0;
}

function monthsUntil(dateStr) {
  const t = new Date(dateStr + 'T23:59:59').getTime();
  if (isNaN(t)) return 0;
  return (t - Date.now()) / (30.44 * 86400000);
}

function requiredPerMonth(g) {
  if (!g.deadline) return 0;
  const remaining = Math.max(0, g.target - (Number(g.current) || 0));
  if (remaining <= 0) return 0;
  const months = monthsUntil(g.deadline);
  if (months <= 0) return 0;
  return Math.ceil(remaining / months);
}

function deadlineText(g) {
  const days = Math.ceil((new Date(g.deadline + 'T23:59:59').getTime() - Date.now()) / 86400000);
  if (days < 0) return `Deadline passed ${Math.abs(days)} d ago`;
  if (days <= 60) return `Due in ${days} d`;
  return `Due in ${Math.round(days / 30.44)} mo`;
}

function goalStatus(g) {
  const cur = Number(g.current) || 0;
  if (cur >= g.target) return { cls: 'done', label: 'Completed' };
  if (!g.deadline) return null;
  const dl = new Date(g.deadline + 'T23:59:59').getTime();
  if (dl < Date.now()) return { cls: 'late', label: 'Deadline passed' };
  const created = new Date(String(g.createdAt || '').slice(0, 10) + 'T00:00:00').getTime() || Date.now();
  const span = dl - created;
  if (span <= 0) return { cls: 'ok', label: 'On track' };
  const expected = (Date.now() - created) / span;
  return cur / g.target >= expected - 0.02 ? { cls: 'ok', label: 'On track' } : { cls: 'behind', label: 'Behind pace' };
}

function sortGoals(goals) {
  const arr = goals.slice();
  switch (savingsSort) {
    case 'progress-desc': arr.sort((a, b) => goalPct(b) - goalPct(a) || b.target - a.target); break;
    case 'progress-asc': arr.sort((a, b) => goalPct(a) - goalPct(b) || b.target - a.target); break;
    case 'deadline': arr.sort((a, b) => (a.deadline || '9999-99-99') < (b.deadline || '9999-99-99') ? -1 : 1); break;
    case 'target-desc': arr.sort((a, b) => b.target - a.target); break;
    case 'name': arr.sort((a, b) => a.name.localeCompare(b.name)); break;
  }
  return arr;
}

function goalCard(g, totalSaved) {
  const cur = Number(g.current) || 0;
  const pct = g.target ? Math.min((cur / g.target) * 100, 100) : 0;
  const done = cur >= g.target;
  const remaining = Math.max(0, g.target - cur);
  const perMonth = requiredPerMonth(g);
  const share = totalSaved ? Math.round((cur / totalSaved) * 100) : 0;
  const st = goalStatus(g);
  const lastFromExp = state.expenses
    .filter(x => x.goalId === g.id)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  if (g.id === editingGoalId) {
    return `
      <div class="goal-card editing">
        <h3>Edit goal</h3>
        <label class="field"><span class="field-label">Name</span><input type="text" id="editName" value="${escapeHtml(g.name)}" /></label>
        <label class="field"><span class="field-label">Target amount</span><input type="number" id="editTarget" step="0.01" min="1" value="${g.target}" /></label>
        <label class="field"><span class="field-label">Saved so far</span><input type="number" id="editCurrent" step="0.01" min="0" value="${cur}" /></label>
        <label class="field"><span class="field-label">Goal date</span><input type="date" id="editDeadline" value="${g.deadline || ''}" /></label>
        <div class="goal-actions">
          <button data-save-edit="${g.id}" class="primary-sm">Save</button>
          <button data-cancel-edit>Cancel</button>
          <button class="gb-del" data-del-goal="${g.id}" title="Delete goal">✕</button>
        </div>
      </div>`;
  }

  return `
    <div class="goal-card ${done ? 'is-done' : ''}">
      <div class="goal-top">
        <h3>${escapeHtml(g.name)}</h3>
        ${st ? `<span class="goal-chip ${st.cls}">${st.label}</span>` : ''}
      </div>
      <div class="goal-meta">
        <span>${g.deadline ? deadlineText(g) : 'No deadline'}</span>
        <span>${share}% of total saved</span>
      </div>
      ${lastFromExp ? `<div class="goal-from">↑ ${fmt(lastFromExp.amount)} added on ${lastFromExp.date} via an expense</div>` : ''}
      <div class="goal-bar"><div style="width:${pct}%"></div></div>
      <div class="goal-stats">
        <span>${fmt(cur)} of ${fmt(g.target)}</span>
        <span class="pct">${Math.round(pct)}%</span>
      </div>
      ${!done ? `<div class="goal-stats">
        <span>${fmt(remaining)} to go</span>
        ${perMonth ? `<span>${fmt(perMonth)}/mo to stay on pace</span>` : ''}
      </div>` : `<div class="goal-achieved">🎉 Goal achieved!</div>`}
      <div class="goal-actions">
        <input type="number" min="1" step="0.01" data-add-goal="${g.id}" placeholder="Add savings…" />
        <button data-add-goal-btn="${g.id}">Add</button>
        <button data-edit-goal="${g.id}">Edit</button>
        <button class="gb-del" data-del-goal="${g.id}" title="Delete goal">✕</button>
      </div>
    </div>`;
}

function renderSavings() {
  const totalSaved = state.savingsGoals.reduce((s, g) => s + (Number(g.current) || 0), 0);
  const totalTarget = state.savingsGoals.reduce((s, g) => s + (Number(g.target) || 0), 0);
  const n = state.savingsGoals.length;
  const doneCount = state.savingsGoals.filter(g => (Number(g.current) || 0) >= g.target).length;
  const overallPct = totalTarget ? Math.min((totalSaved / totalTarget) * 100, 100) : 0;

  document.getElementById('totalSavedAll').textContent = fmt(totalSaved);
  document.getElementById('totalTargetAll').textContent = n && totalTarget ? `of ${fmt(totalTarget)} target` : '';
  const mEl = document.getElementById('savingsMeta');
  mEl.textContent = n
    ? `${n} goal${n > 1 ? 's' : ''} · ${fmt(Math.max(0, totalTarget - totalSaved))} still to save${doneCount ? ` · ${doneCount} completed` : ''}`
    : 'No goals yet — create one to start tracking';
  document.getElementById('overallPct').textContent = n ? `${Math.round(overallPct)}% overall` : '';
  document.getElementById('ssBarFill').style.width = (n ? overallPct : 0) + '%';

  const grid = document.getElementById('goalsList');
  if (!n) {
    grid.innerHTML = `<div class="empty">No savings goals yet. Create your first one above — each goal gets a progress bar, pace tracking, and an add-money action, and they all add up to the total at the top.</div>`;
    renderGoalsChart();
    return;
  }
  grid.innerHTML = sortGoals(state.savingsGoals).map(g => goalCard(g, totalSaved)).join('');
  renderGoalsChart();
}

/* ---------- recurring templates ---------- */
const REC_LABELS = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly', yearly: 'Yearly' };
function renderRecurring() {
  const grid = document.getElementById('recurringList');
  const tpls = state.recurringTemplates;
  if (!tpls.length) {
    grid.innerHTML = `<div class="empty">No recurring templates yet. Mark an expense or income as recurring in its form to create one — upcoming occurrences are projected here, read-only.</div>`;
    return;
  }
  grid.innerHTML = tpls.map(t => {
    const next = projectOccurrences(t, 5).slice(1).join(', ');
    const typeLabel = t.type === 'income' ? 'Income' : 'Expense';
    const color = t.type === 'income' ? '#35d0a1' : '#ff7a59';
    return `<div class="rec-card">
      <div class="rec-head">
        <span class="rec-type" style="background:${color}">${typeLabel}</span>
        <span class="rec-name">${escapeHtml(t.description || t.category || t.source || 'Untitled')}</span>
        ${t.removed ? '' : `<button class="icon-btn small" data-del-template="${t.id}" title="Remove template">✕</button>`}
      </div>
      <div class="rec-amount">${fmt(t.amount)}</div>
      <div class="rec-meta">Every ${REC_LABELS[t.frequency] || t.frequency} · from ${t.date}</div>
      <div class="rec-next">Next: ${next || '—'}</div>
    </div>`;
  }).join('');
}

document.getElementById('recurringList').addEventListener('click', (e) => {
  const id = e.target.getAttribute('data-del-template');
  if (!id) return;
  state.recurringTemplates = state.recurringTemplates.filter(t => t.id !== id);
  scheduleSave();
  render();
});

/* ---------- debts ---------- */
function renderDebts() {
  const grid = document.getElementById('debtsList');
  const arr = state.debts || [];
  if (!arr.length) {
    grid.innerHTML = `<div class="empty">No debts recorded. Add one to track what you owe or what is owed to you.</div>`;
    return;
  }
  grid.innerHTML = arr.map(d => {
    const kind = d.type === 'owed' ? 'Owed to you' : 'You owe';
    const monthlyInterest = (Number(d.rate) || 0) / 100 / 12;
    const interestThisMonth = Math.round((Number(d.balance) || 0) * monthlyInterest);
    return `<div class="rec-card">
      <div class="rec-head">
        <span class="rec-type" style="background:${d.type === 'owed' ? '#35d0a1' : '#ff7a59'}">${kind}</span>
        <span class="rec-name">${escapeHtml(d.name)}</span>
        ${d.removed ? '' : `<button class="icon-btn small" data-del-debt="${d.id}" title="Remove">✕</button>`}
      </div>
      <div class="rec-amount">${fmt(Number(d.balance) || 0)}</div>
      <div class="rec-meta">Interest ${(Number(d.rate) || 0)}% / yr${(Number(d.min) || 0) ? ' · min payment ' + fmt(Number(d.min)) : ''}</div>
      <div class="rec-next">${interestThisMonth ? '~' + fmt(interestThisMonth) + ' interest this month' : '—'}</div>
    </div>`;
  }).join('');
  renderDebtChart(arr);
}

function renderDebtChart(arr) {
  const canvas = document.getElementById('debtChart');
  if (!canvas) return;
  const data = {};
  arr.forEach(d => {
    const label = d.type === 'owed' ? 'Owed to you' : 'You owe';
    data[label] = (data[label] || 0) + (Number(d.balance) || 0);
  });
  renderCategoryChart('debtChart', data);
}

document.getElementById('debtForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('debtName').value.trim();
  if (!name) return toast('Debt name is required', true);
  state.debts.push({
    id: uid(),
    name,
    type: document.getElementById('debtType').value,
    balance: parseFloat(document.getElementById('debtAmount').value),
    rate: parseFloat(document.getElementById('debtRate').value) || null,
    min: parseFloat(document.getElementById('debtMin').value) || null,
  });
  e.target.reset();
  scheduleSave();
  render();
});

document.getElementById('debtsList').addEventListener('click', (e) => {
  const id = e.target.getAttribute('data-del-debt');
  if (!id) return;
  state.debts = state.debts.filter(d => d.id !== id);
  scheduleSave();
  render();
});

/* ---------- accounts ---------- */
function renderAccounts() {
  const grid = document.getElementById('accountsList');
  const arr = state.accounts || [];
  if (!arr.length) {
    grid.innerHTML = `<div class="empty">No accounts yet. Add one to categorize where your money lives.</div>`;
    return;
  }
  grid.innerHTML = arr.map(a => {
    const label = a.type === 'card' ? 'Card / Bank' : 'Cash';
    return `<div class="rec-card">
      <div class="rec-head">
        <span class="rec-type" style="background:${a.type === 'card' ? '#6c7ee5' : '#35d0a1'}">${escapeHtml(label)}</span>
        <span class="rec-name">${escapeHtml(a.name)}</span>
        ${a.removed ? '' : `<button class="icon-btn small" data-del-acct="${a.id}" title="Remove">✕</button>`}
      </div>
      <div class="rec-amount">${fmt(Number(a.balance) || 0)}</div>
    </div>`;
  }).join('');
}

document.getElementById('accountForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('acctName').value.trim();
  if (!name) return toast('Account name is required', true);
  state.accounts.push({
    id: uid(),
    name,
    type: document.getElementById('acctType').value,
    balance: parseFloat(document.getElementById('acctBalance').value) || 0,
  });
  e.target.reset();
  scheduleSave();
  render();
});

document.getElementById('accountsList').addEventListener('click', (e) => {
  const id = e.target.getAttribute('data-del-acct');
  if (!id) return;
  state.accounts = state.accounts.filter(a => a.id !== id);
  scheduleSave();
  render();
});

function saveGoalEdit(id) {
  const g = state.savingsGoals.find(x => x.id === id);
  if (!g) return;
  const name = document.getElementById('editName').value.trim();
  const target = parseFloat(document.getElementById('editTarget').value);
  const current = parseFloat(document.getElementById('editCurrent').value);
  const deadline = document.getElementById('editDeadline').value || '';
  if (!name) return toast('Goal name is required', true);
  if (!target || target <= 0) return toast('Target must be greater than 0', true);
  Object.assign(g, { name, target, current: Number.isFinite(current) && current >= 0 ? current : 0, deadline });
  editingGoalId = null;
  scheduleSave();
  render();
  toast('Goal updated');
}

document.getElementById('goalSort').addEventListener('change', (e) => {
  savingsSort = e.target.value;
  renderSavings();
});

document.getElementById('goalsList').addEventListener('click', (e) => {
  const t = e.target;
  const addId = t.getAttribute('data-add-goal-btn');
  const delId = t.getAttribute('data-del-goal');
  const editId = t.getAttribute('data-edit-goal');
  const saveId = t.getAttribute('data-save-edit');
  if (addId) { addSavings(addId); return; }
  if (saveId) { saveGoalEdit(saveId); return; }
  if (t.hasAttribute('data-cancel-edit')) { editingGoalId = null; renderSavings(); return; }
  if (editId) { editingGoalId = editId; renderSavings(); return; }
  if (delId) { if (editingGoalId === delId) editingGoalId = null; removeSavings(delId); }
});
document.getElementById('goalsList').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.addGoal) addSavings(e.target.dataset.addGoal);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- charts (canvas, no library) ---------- */
function clearCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (!canvas.dataset.baseW) {
    canvas.dataset.baseW = canvas.width;
    canvas.dataset.baseH = canvas.height;
  }
  const boxW = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
  const cssW = canvas.clientWidth || boxW || +canvas.dataset.baseW;
  const cssH = canvas.clientHeight || Math.round(cssW * (+canvas.dataset.baseH / +canvas.dataset.baseW));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}

function renderCategoryChart(canvasId, map) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const { ctx, w, h } = clearCanvas(canvas);
  const padL = 90, padR = 20, padT = 15, padB = 20;
  if (!entries.length) {
    ctx.fillStyle = '#9aa3b2'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No data yet', w / 2, h / 2); return;
  }
  const max = Math.max(1, ...entries.map(e => e[1])) * 1.1;
  const barH = (h - padT - padB) / entries.length - 8;
  entries.forEach((e, i) => {
    const y = padT + i * ((h - padT - padB) / entries.length);
    const bw = ((e[1] / max) * (w - padL - padR));
    ctx.fillStyle = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
    ctx.fillRect(padL, y, bw, barH);
    ctx.fillStyle = '#e6e9ef'; ctx.textAlign = 'right'; ctx.font = '12px system-ui';
    ctx.fillText(e[0], padL - 8, y + barH / 2 + 4);
    ctx.textAlign = 'left';
    ctx.fillText(fmtShort(e[1]), padL + bw + 6, y + barH / 2 + 4);
  });
}

function renderGroupedBar(canvasId, series) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const labels = series.labels;
  const { ctx, w, h } = clearCanvas(canvas);
  const padL = 50, padR = 15, padT = 15, padB = 40;
  if (!labels.length) {
    ctx.fillStyle = '#9aa3b2'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No data yet', w / 2, h / 2); return;
  }
  const max = Math.max(1, ...series.datasets.flatMap(d => d.data)) * 1.1;
  const plotW = w - padL - padR;
  const groupW = plotW / labels.length;
  const barW = Math.min(groupW / (series.datasets.length + 1), 40);
  const legend = document.getElementById(canvasId + '_legend');
  labels.forEach((lbl, i) => {
    const gx = padL + i * groupW + groupW / 2;
    series.datasets.forEach((ds, di) => {
      const bx = gx - (series.datasets.length * barW) / 2 + di * barW;
      const by = h - padB - (ds.data[i] / max) * (h - padT - padB);
      ctx.fillStyle = ds.color;
      ctx.fillRect(bx, by, barW - 3, (h - padB) - by);
    });
    ctx.fillStyle = '#9aa3b2'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(lbl, gx, h - padB + 18);
  });
  if (legend) legend.innerHTML = series.datasets.map(d =>
    `<span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px;font-size:12px;color:#9aa3b2"><span style="width:12px;height:12px;background:${d.color};border-radius:3px;display:inline-block"></span>${d.label}</span>`
  ).join('');
}

function renderMonthlyChart() {
  const months = new Set();
  state.expenses.forEach(e => months.add(ym(e.date)));
  state.income.forEach(i => months.add(ym(i.date)));
  const labels = [...months].sort();
  const short = labels.length > 8;
  const byMonth = (arr) => {
    const m = {};
    arr.forEach(x => { if (ym(x.date)) m[ym(x.date)] = (m[ym(x.date)] || 0) + x.amount; });
    return labels.map(l => m[l] || 0);
  };
  renderGroupedBar('monthlyChart', {
    labels: labels.map(l => monthLabel(l, short)),
    datasets: [
      { label: 'Income', data: byMonth(state.income), color: '#35d0a1' },
      { label: 'Expenses', data: byMonth(state.expenses.filter(e => !isTransfer(e))), color: '#ff7a59' },
    ],
  });
}

function renderBudgetChart() {
  const month = ym(today());
  const spent = expensesByCategory(month);
  const entries = state.budgets.map(b => [b.category, b.amount, spent[b.category] || 0]);
  const canvas = document.getElementById('budgetChart');
  if (!canvas) return;
  const { ctx, w, h } = clearCanvas(canvas);
  const padL = 90, padT = 15, padB = 20, padR = 80;
  if (!entries.length) {
    ctx.fillStyle = '#9aa3b2'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Set budgets to compare', w / 2, h / 2); return;
  }
  const max = Math.max(1, ...entries.map(e => Math.max(e[1], e[2]))) * 1.1;
  const rowH = (h - padT - padB) / entries.length - 8;
  entries.forEach((e, i) => {
    const y = padT + i * ((h - padT - padB) / entries.length);
    const [cat, budget, sp] = e;
    const bw = (budget / max) * (w - padL - padR);
    const sw = (sp / max) * (w - padL - padR);
    ctx.fillStyle = '#4f9dff'; ctx.fillRect(padL, y, bw, rowH);
    if (sp > budget) { ctx.fillStyle = '#ff5c6c'; ctx.fillRect(padL, y, sw, rowH); }
    ctx.fillStyle = '#e6e9ef'; ctx.textAlign = 'right'; ctx.font = '12px system-ui';
    ctx.fillText(cat, padL - 8, y + rowH / 2 + 4);
    const over = sp > budget;
    ctx.fillStyle = over ? '#ff5c6c' : '#9aa3b2'; ctx.textAlign = 'left';
    const pct = budget > 0 ? Math.round((sp / budget) * 100) + '%' : (sp > 0 ? 'over (no budget)' : '—');
    ctx.fillText(pct, padL + bw + 6, y + rowH / 2 + 4);
  });
}

function renderGoalsChart() {
  drawGoalsProgress('goalsChart');
  drawGoalsProgress('savingsChart');
}

function drawGoalsProgress(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const { ctx, w, h } = clearCanvas(canvas);
  const padL = 20, padR = 20, padT = 15, padB = 20;
  const goals = state.savingsGoals;
  if (!goals.length) {
    ctx.fillStyle = '#9aa3b2'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No goals yet', w / 2, h / 2); return;
  }
  const max = Math.max(1, ...goals.map(g => Number(g.target) || 0)) * 1.1;
  const n = goals.length;
  const gap = 26;
  const top = padT;
  const barH = Math.min(gap - 8, (h - top - padB) / n);
  goals.forEach((g, i) => {
    const y = top + i * gap;
    const targetW = (g.target / max) * (w - padL - padR);
    const curW = (g.current / max) * (w - padL - padR);
    ctx.fillStyle = '#2a2f3a'; ctx.fillRect(padL, y, targetW, barH);
    ctx.fillStyle = '#35d0a1'; ctx.fillRect(padL, y, curW, barH);
    ctx.fillStyle = '#e6e9ef'; ctx.textAlign = 'left'; ctx.font = '12px system-ui';
    ctx.fillText(g.name, padL + targetW + 8, y + barH / 2 + 4);
  });
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const inc = state.income.filter(x => inDashPeriod(x.date)).reduce((s, x) => s + x.amount, 0);
  const exp = totalSpend(inDashPeriod);
  const transferred = totalTransfers(inDashPeriod);
  const net = inc - exp;
  const totalSaved = state.savingsGoals.reduce((s, g) => s + (Number(g.current) || 0), 0);
  const totalTarget = state.savingsGoals.reduce((s, g) => s + (Number(g.target) || 0), 0);
  const pt = periodText();

  document.getElementById('totalIncome').textContent = fmt(inc);
  document.getElementById('totalExpenses').textContent = fmt(exp);
  const netEl = document.getElementById('netThisPeriod');
  netEl.textContent = (net < 0 ? '-' : '') + fmt(Math.abs(net));
  netEl.className = 'card-value' + (net < 0 ? ' net-value neg' : '');
  document.getElementById('totalSavings').textContent = fmt(totalSaved);

  document.getElementById('incSub').textContent = 'Earned in ' + pt;
  document.getElementById('expSub').textContent = 'Spent in ' + pt;
  document.getElementById('netSub').textContent = 'Income minus expenses in ' + pt;
  const goalCount = state.savingsGoals.length;
  document.getElementById('savSub').textContent = goalCount
    ? goalCount + ' goal' + (goalCount > 1 ? 's' : '') + ' · ' + fmt(totalTarget) + ' total target (all time)'
    : 'No savings goals yet (all time)';
  const spendSub = document.getElementById('spendSub');
  if (spendSub) spendSub.textContent = pt === 'all time' ? '' : '· ' + pt;

  // Insights: savings rate, fixed vs variable, next-30-day projection
  let fixed = 0, variable = 0;
  state.expenses.forEach(x => {
    if (isTransfer(x) || !inDashPeriod(x.date)) return;
    if (isFixedCategory(x.category)) fixed += Number(x.amount) || 0; else variable += Number(x.amount) || 0;
  });
  const ratePct = inc > 0 ? Math.round((transferred / inc) * 100) : 0;
  const srEl = document.getElementById('savingsRate');
  srEl.textContent = inc > 0 ? ratePct + '%' : '—';
  srEl.className = 'card-value' + (inc < 0 ? ' net-value neg' : '');
  document.getElementById('savingsRateSub').textContent = inc > 0
    ? `${fmt(transferred)} into goals this month`
    : 'No income recorded this month';
  const fvBreak = document.getElementById('fixedVarBreak');
  fvBreak.textContent = (fixed || variable) ? fmt(fixed) + ' / ' + fmt(variable) : '—';
  document.getElementById('fixedVarSub').textContent = (fixed || variable)
    ? 'Fixed expenses · Variable expenses (this month)'
    : 'Not enough data yet';
  const proj = projectUpcoming(30);
  const n30 = document.getElementById('next30Proj');
  const diff = proj.spending - proj.income;
  n30.textContent = proj.spending || proj.income ? fmt(diff) : '—';
  n30.className = 'card-value' + (diff < 0 ? ' net-value neg' : '');
  document.getElementById('next30Sub').textContent = proj.spending || proj.income
    ? `${proj.count} recurring item(s): ${fmt(proj.income)} in · ${fmt(proj.spending)} out`
    : 'No recurring templates yet';

  renderCategoryChart('spendChart', expensesByCategory(null, inDashPeriod));
  renderMonthlyChart();
  renderGoalsChart();
}

/* ---------- render all ---------- */
function render() {
  populateCategorySelects();
  populateGoalSelect();
  populateAccountSelect();
  toggleGoalField();
  renderDashboard();
  renderExpenses();
  renderIncome();
  renderBudgets();
  renderSavings();
  renderRecurring();
  renderDebts();
  renderAccounts();
  renderReview();
  renderHistory();
}

/* ---------- options: export / import / demo / reset ---------- */
document.getElementById('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('optionsMenu').classList.toggle('hidden');
  document.getElementById('menuOverlay').classList.toggle('hidden');
});
document.getElementById('menuOverlay').addEventListener('click', () => {
  document.getElementById('optionsMenu').classList.add('hidden');
  document.getElementById('menuOverlay').classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#optionsMenu') && !e.target.closest('#menuBtn')) {
    document.getElementById('optionsMenu').classList.add('hidden');
    document.getElementById('menuOverlay').classList.add('hidden');
  }
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moneywala-backup-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Data exported');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
    const data = JSON.parse(reader.result);
    const snapshot = JSON.parse(JSON.stringify(state));
    Object.assign(state, Object.assign(defaultData(), data));
    seedAndMigrate();
    state.alertsShown = state.alertsShown || {};
    scheduleSave();
    render();
    toast('Data imported');
    recordChange('Data imported', 'Previous state restored on undo', () => { Object.assign(state, snapshot); scheduleSave(); render(); });
    } catch { toast('Invalid file', true); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('demoBtn').addEventListener('click', () => {
  if (!confirm('This will replace your data with sample data. Continue?')) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  Object.assign(state, demoData());
  scheduleSave();
  render();
  checkBudgetAlerts();
  toast('Demo data loaded');
  recordChange('Demo data loaded', 'Previous state restored on undo', () => { Object.assign(state, snapshot); scheduleSave(); render(); });
});

const resetBtn = document.getElementById('resetBtn');
if (resetBtn) resetBtn.addEventListener('click', async () => {
  if (!confirm('This PERMANENTLY deletes ALL data. Continue?')) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  const res = await fetch('/api/reset', { method: 'POST' });
  if (res.ok) {
    Object.assign(state, defaultData());
    seedAndMigrate();
    state.alertsShown = {};
    document.getElementById('currencySelect').value = state.currency;
    render();
    toast('All data cleared');
    recordChange('All data reset', 'Previous state restored on undo', () => { Object.assign(state, snapshot); scheduleSave(); render(); });
    } else toast('Reset failed', true);
});

document.getElementById('exitBtn').addEventListener('click', async () => {
  if (!confirm('Exit the application server?')) return;
  try {
    const res = await fetch('/api/exit', { method: 'POST' });
    if (!res.ok) throw new Error('exit failed');
    document.open();
    document.write('<!doctype html><meta charset="utf-8"><title>Moneywala</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#94a3b8;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}</style><div>The server has exited.<br>Close this tab, or restart the server and reload this page.</div>');
    document.close();
  } catch {
    toast('Failed to exit server', true);
  }
});

/* ---------- demo data ---------- */
function demoData() {
  function mulberry32(a) {
    return function() {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(12345);
  const ri = (lo, hi) => Math.floor(rand() * (hi - lo + 1)) + lo;
  const rf = (lo, hi) => Math.round((rand() * (hi - lo) + lo) * 100) / 100;

  const now = new Date();
  const iso = (y, m, day) => {
    const maxD = new Date(y, m + 1, 0).getDate();
    const dd = Math.min(day, maxD);
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  };
  const gd = (mo, day) => {
    const d = new Date(now.getFullYear(), now.getMonth() + mo, day);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  const expenses = [];
  const income = [];
  const recurringTemplates = [];

  const addExp = (date, amount, category, desc, o) => {
    const e = { id: uid(), date, amount, category, description: desc || '', goalId: null, goalName: null, tags: [], notes: '', recurring: null, account: null };
    if (o) Object.assign(e, o);
    expenses.push(e);
    return e;
  };
  const addInc = (date, amount, source, desc, o) => {
    const e = { id: uid(), date, amount, source, description: desc || '', tags: [], notes: '', recurring: null };
    if (o) Object.assign(e, o);
    income.push(e);
    return e;
  };
  const addTransfer = (date, amount, g, o) => {
    const e = addExp(date, amount, 'Savings', 'Transfer to ' + g.name, o);
    e.goalId = g.id;
    e.goalName = g.name;
    return e;
  };
  const addTemplate = (kind, freq, amount, mo, catOrSrc, desc) => {
    const id = uid();
    const d = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const t = { kind, id, type: kind, amount, date, frequency: freq, description: desc || '', tags: [], notes: '' };
    if (kind === 'expense') { t.category = catOrSrc; t.goalId = null; } else { t.source = catOrSrc; }
    recurringTemplates.push(t);
    return id;
  };

  const gVacation = { id: uid(), name: 'Vacation Fund', target: 3000, current: 2200, deadline: gd(6, 1), createdAt: gd(-12, 1) };
  const gEmergency = { id: uid(), name: 'Emergency Fund', target: 10000, current: 4500, deadline: '', createdAt: gd(-15, 1) };
  const gLaptop = { id: uid(), name: 'New Laptop', target: 1500, current: 1500, deadline: '', createdAt: gd(-18, 1) };
  const gCar = { id: uid(), name: 'Car Repair', target: 2000, current: 800, deadline: gd(-2, 1), createdAt: gd(-8, 1) };
  const gReno = { id: uid(), name: 'Home Reno', target: 5000, current: 1000, deadline: gd(10, 1), createdAt: gd(-6, 1) };
  const savingsGoals = [gVacation, gEmergency, gLaptop, gCar, gReno];

  const budgets = [
    { id: uid(), category: 'Housing', amount: 1500 },
    { id: uid(), category: 'Groceries', amount: 400 },
    { id: uid(), category: 'Dining', amount: 150 },
    { id: uid(), category: 'Entertainment', amount: 200 },
    { id: uid(), category: 'Utilities', amount: 250 },
    { id: uid(), category: 'Fuel', amount: 100 },
    { id: uid(), category: 'Healthcare', amount: 200 },
    { id: uid(), category: 'Clothing', amount: 300 },
    { id: uid(), category: 'Personal', amount: 400 },
    { id: uid(), category: 'Transport', amount: 150 },
    { id: uid(), category: 'Maintenance', amount: 300 },
  ];

  const debts = [
    { id: uid(), name: 'Credit Card A', type: 'youOwe', balance: 3200, rate: 22, min: 95 },
    { id: uid(), name: 'Student Loan', type: 'youOwe', balance: 18500, rate: 5.5, min: 210 },
    { id: uid(), name: 'Friend (Ali)', type: 'owed', balance: 450, rate: null, min: null },
  ];

  const accounts = [
    { id: uid(), name: 'Main Checking', type: 'card', balance: 4250 },
    { id: uid(), name: 'Savings Account', type: 'card', balance: 8500 },
    { id: uid(), name: 'Cash Wallet', type: 'cash', balance: 320 },
    { id: uid(), name: 'Credit Card', type: 'card', balance: -1850 },
  ];

  addTemplate('income', 'monthly', 4200, -18, 'Salary', 'Monthly salary');
  addTemplate('income', 'monthly', 500, -10, 'Freelance', 'Side project');
  addTemplate('expense', 'monthly', 1400, -18, 'Housing', 'Rent');
  addTemplate('expense', 'monthly', 80, -18, 'Utilities', 'Internet');
  addTemplate('expense', 'monthly', 45, -18, 'Utilities', 'Phone bill');
  addTemplate('expense', 'monthly', 120, -18, 'Insurance', 'Health insurance');
  addTemplate('expense', 'monthly', 350, -15, 'Debt', 'Car loan');
  addTemplate('expense', 'weekly', 15, -12, 'Entertainment', 'Streaming');
  addTemplate('expense', 'biweekly', 25, -12, 'Healthcare', 'Gym');
  addTemplate('expense', 'daily', 4, -6, 'Dining', 'Coffee');
  addTemplate('expense', 'yearly', 2500, -14, 'Other', 'Annual tax');
  addTemplate('expense', 'yearly', 1200, -14, 'Insurance', 'Car insurance');
  addTemplate('expense', 'biweekly', 150, -8, 'Personal', 'Child support');

  for (let mo = -17; mo <= 0; mo++) {
    const base = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    const y = base.getFullYear();
    const m = base.getMonth();
    const isCur = (mo === 0);
    const d = (day) => iso(y, m, day);

    addExp(d(1), 1400, 'Housing', 'Rent', { recurring: 'monthly', account: 'Main Checking' });
    addExp(d(5), 80, 'Utilities', 'Internet', { recurring: 'monthly', account: 'Main Checking' });
    addExp(d(8), 45, 'Utilities', 'Phone bill', { recurring: 'monthly', account: 'Main Checking' });
    addExp(d(10), 120, 'Insurance', 'Health insurance', { recurring: 'monthly', account: 'Main Checking' });
    if (mo >= -15) addExp(d(12), 350, 'Debt', 'Car loan payment', { recurring: 'monthly', account: 'Main Checking' });

    addInc(d(1), 4200, 'Salary', 'Monthly salary', { recurring: 'monthly' });
    if (mo >= -10) addInc(d(15), 500, 'Freelance', 'Side project', { recurring: 'monthly' });

    if (mo >= -12) addExp(d(ri(10, 20)), 15, 'Entertainment', 'Streaming service', { recurring: 'weekly', account: 'Credit Card' });
    if (mo >= -12) addExp(d(ri(3, 15)), 25, 'Healthcare', 'Gym membership', { recurring: 'biweekly', account: 'Main Checking' });
    if (mo >= -6) {
      addExp(d(ri(2, 10)), 4, 'Dining', 'Coffee', { recurring: 'daily', account: 'Cash Wallet' });
      addExp(d(ri(11, 25)), 4.5, 'Dining', 'Coffee', { recurring: 'daily', account: 'Cash Wallet' });
    }
    if (mo === -14) {
      addExp(d(15), 2500, 'Other', 'Annual tax payment', { recurring: 'yearly', account: 'Main Checking', notes: 'Annual tax filing' });
      addExp(d(20), 1200, 'Insurance', 'Car insurance renewal', { recurring: 'yearly', account: 'Main Checking' });
    }
    if (mo >= -8) {
      addExp(d(5), 150, 'Personal', 'Child support', { recurring: 'biweekly', account: 'Main Checking' });
      addExp(d(19), 150, 'Personal', 'Child support', { recurring: 'biweekly', account: 'Main Checking' });
    }

    if (isCur) {
      addExp(d(3), 45, 'Dining', 'Lunch out', { account: 'Credit Card', tags: ['lunch'] });
      addExp(d(10), 65, 'Dining', 'Dinner with friends', { account: 'Credit Card', tags: ['social'], notes: 'Anniversary dinner' });
      addExp(d(16), 40, 'Dining', 'Takeout', { account: 'Cash Wallet' });
      addExp(d(22), 35, 'Dining', 'Brunch', { account: 'Credit Card', tags: ['weekend'] });
      addExp(d(2), 130, 'Groceries', 'Weekly shop', { account: 'Main Checking' });
      addExp(d(12), 120, 'Groceries', 'Supermarket', { account: 'Main Checking', tags: ['weekly'] });
      addExp(d(21), 110, 'Groceries', 'Groceries', { account: 'Main Checking' });
      addExp(d(7), 70, 'Entertainment', 'Concert tickets', { account: 'Credit Card', tags: ['concert'] });
      addExp(d(18), 60, 'Entertainment', 'Movie night', { account: 'Credit Card' });
      addExp(d(9), 55, 'Fuel', 'Gas refill', { account: 'Main Checking' });
      addExp(d(6), 65, 'Healthcare', 'Pharmacy', { account: 'Credit Card' });
      addExp(d(14), 85, 'Personal', 'Haircut & personal care', { account: 'Cash Wallet' });
      addExp(d(4), 60, 'Transport', 'Taxi ride', { account: 'Credit Card' });
      addExp(d(20), 50, 'Transport', 'Ride share', { account: 'Credit Card', tags: ['work'] });
      addExp(d(11), 35, 'Other', 'Misc', { account: 'Cash Wallet' });
    } else {
      const nG = ri(2, 4);
      for (let i = 0; i < nG; i++) addExp(d(ri(1, 28)), rf(80, 150), 'Groceries', 'Groceries', { account: 'Main Checking' });
      const nD = ri(2, 4);
      for (let i = 0; i < nD; i++) addExp(d(ri(1, 28)), rf(15, 60), 'Dining', 'Restaurant', { account: rand() > 0.5 ? 'Credit Card' : 'Cash Wallet' });
      const nF = ri(1, 2);
      for (let i = 0; i < nF; i++) addExp(d(ri(1, 28)), rf(40, 70), 'Fuel', 'Gas', { account: 'Main Checking' });
      const nE = ri(0, 2);
      for (let i = 0; i < nE; i++) addExp(d(ri(1, 28)), rf(20, 80), 'Entertainment', 'Fun', { account: 'Credit Card' });
      if (rand() > 0.4) addExp(d(ri(1, 28)), rf(30, 120), 'Healthcare', 'Medical', { account: 'Credit Card' });
      if (rand() > 0.6) addExp(d(ri(1, 28)), rf(50, 200), 'Clothing', 'Clothes', { account: 'Credit Card' });
      const nP = ri(0, 2);
      for (let i = 0; i < nP; i++) addExp(d(ri(1, 28)), rf(30, 100), 'Personal', 'Personal', { account: 'Cash Wallet' });
      if (rand() > 0.5) addExp(d(ri(1, 28)), rf(20, 60), 'Transport', 'Transport', { account: 'Credit Card' });
      if (rand() > 0.5) addExp(d(ri(1, 28)), rf(20, 100), 'Other', 'Misc', { account: 'Cash Wallet' });
      if (rand() > 0.7) addExp(d(ri(1, 28)), rf(50, 250), 'Maintenance', 'Repairs', { account: 'Main Checking' });
    }

    const nT = ri(1, 2);
    const tGoals = [gVacation, gEmergency, gReno];
    for (let i = 0; i < nT; i++) {
      const g = tGoals[ri(0, tGoals.length - 1)];
      addTransfer(d(ri(1, 28)), rf(100, 300), g, { account: 'Main Checking' });
    }

    if (rand() > 0.3) addInc(d(ri(10, 25)), rf(200, 600), 'Freelance', 'Freelance project');
    if (rand() > 0.5) addInc(d(25), rf(50, 150), 'Interest', 'Bank interest');
  }

  {
    const b = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    addInc(iso(b.getFullYear(), b.getMonth(), 15), 2000, 'Bonus', 'Performance bonus', { tags: ['bonus'], notes: 'Year-end performance bonus' });
  }
  {
    const b = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    addExp(iso(b.getFullYear(), b.getMonth(), 10), 1500, 'Travel', 'Trip to Europe', { account: 'Credit Card', tags: ['trip', 'vacation'], notes: 'Flight + hotel' });
  }
  {
    const b = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    addExp(iso(b.getFullYear(), b.getMonth(), 15), 800, 'Healthcare', 'Dental work', { account: 'Credit Card', notes: 'Root canal + crown' });
  }
  {
    const b = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    addExp(iso(b.getFullYear(), b.getMonth(), 20), 1200, 'Maintenance', 'Roof repair', { account: 'Main Checking', notes: 'Emergency roof leak fix' });
  }

  {
    const b = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const date = iso(b.getFullYear(), b.getMonth(), 12);
    const gid = uid();
    expenses.push({ id: uid(), date, amount: 120, category: 'Dining', description: 'Dinner split', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Credit Card', groupId: gid });
    expenses.push({ id: uid(), date, amount: 50, category: 'Dining', description: 'Main course', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Credit Card', groupId: gid, _splitChild: true });
    expenses.push({ id: uid(), date, amount: 70, category: 'Dining', description: 'Drinks', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Credit Card', groupId: gid, _splitChild: true });
  }
  {
    const b = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const date = iso(b.getFullYear(), b.getMonth(), 8);
    const gid = uid();
    expenses.push({ id: uid(), date, amount: 250, category: 'Groceries', description: 'Grocery run split', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Main Checking', groupId: gid });
    expenses.push({ id: uid(), date, amount: 150, category: 'Groceries', description: 'Food items', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Main Checking', groupId: gid, _splitChild: true });
    expenses.push({ id: uid(), date, amount: 100, category: 'Personal', description: 'Snacks', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Main Checking', groupId: gid, _splitChild: true });
  }
  {
    const b = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const date = iso(b.getFullYear(), b.getMonth(), 15);
    const gid = uid();
    expenses.push({ id: uid(), date, amount: 180, category: 'Entertainment', description: 'Weekend trip split', goalId: null, goalName: null, tags: ['split', 'trip'], notes: 'Split with friend', recurring: null, account: 'Credit Card', groupId: gid });
    expenses.push({ id: uid(), date, amount: 90, category: 'Entertainment', description: 'Tickets', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Credit Card', groupId: gid, _splitChild: true });
    expenses.push({ id: uid(), date, amount: 90, category: 'Dining', description: 'Meals', goalId: null, goalName: null, tags: ['split'], notes: '', recurring: null, account: 'Credit Card', groupId: gid, _splitChild: true });
  }

  return {
    expenses,
    income,
    budgets,
    savingsGoals,
    debts,
    accounts,
    recurringTemplates,
    currency: '$',
    categories: [...DEFAULT_CATEGORIES, 'Travel'],
    alertsShown: {},
  };
}

/* ---------- CSV export ---------- */
document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const rows = [['Date', 'Category', 'Description', 'Amount', 'Tags', 'Notes', 'Recurring', 'Goal']];
  const list = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date));
  list.forEach(x => {
    rows.push([
      x.date,
      x.category,
      x.description || '',
      x.amount.toFixed(2),
      (x.tags || []).join('; '),
      x.notes || '',
      x.recurring || '',
      x.goalName || '',
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moneywala-expenses-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV exported');
});

/* ---------- categories management ---------- */
function openCatModal() {
  document.getElementById('catModalOverlay').classList.remove('hidden');
  document.getElementById('catModal').classList.remove('hidden');
  renderCatList();
}
function closeCatModal() {
  document.getElementById('catModalOverlay').classList.add('hidden');
  document.getElementById('catModal').classList.add('hidden');
}
function renderCatList() {
  const list = document.getElementById('catList');
  const cats = state.categories.length ? state.categories : DEFAULT_CATEGORIES;
  if (!cats.length) {
    list.innerHTML = '<li class="empty">No categories</li>';
    return;
  }
  list.innerHTML = cats.map(c => `
    <li>
      <span class="cat-name">${escapeHtml(c)}</span>
      <button class="del-btn" data-del-cat="${encodeURIComponent(c)}" title="Remove">✕</button>
    </li>`).join('');
}

document.getElementById('manageCatsBtn').addEventListener('click', openCatModal);
document.getElementById('closeCatModal').addEventListener('click', closeCatModal);
document.getElementById('catModalOverlay').addEventListener('click', closeCatModal);

/* ---------- import settings ---------- */
function readSettingsForm() {
  return {
    baseUrl: document.getElementById('llmBaseUrl').value.trim().replace(/\/+$/, ''),
    model: document.getElementById('llmModel').value.trim(),
    threshold: parseFloat(document.getElementById('confThreshold').value),
  };
}
function applySettingsToState(f) {
  const prev = state.settings || defaultSettings();
  state.settings = {
    llm: { baseUrl: f.baseUrl, model: f.model, timeoutMs: (prev.llm && prev.llm.timeoutMs) || 300000 },
    import: { confidenceThreshold: isNaN(f.threshold) ? 0.85 : f.threshold },
  };
}
function validateSettingsForm(f) {
  if (!/^https?:\/\/[^\s/]+/.test(f.baseUrl)) return 'Enter a valid endpoint URL (e.g. http://127.0.0.1:8080)';
  if (!f.model) return 'Enter a model name';
  if (isNaN(f.threshold) || f.threshold < 0 || f.threshold > 1) return 'Confidence must be between 0 and 1';
  return null;
}
function openSettingsModal() {
  const s = state.settings || defaultSettings();
  document.getElementById('llmBaseUrl').value = (s.llm && s.llm.baseUrl) || '';
  document.getElementById('llmModel').value = (s.llm && s.llm.model) || '';
  document.getElementById('confThreshold').value = (s.import && s.import.confidenceThreshold != null) ? s.import.confidenceThreshold : 0.85;
  const result = document.getElementById('llmTestResult');
  result.textContent = '';
  result.className = 'settings-status';
  document.getElementById('settingsModalOverlay').classList.remove('hidden');
  document.getElementById('settingsModal').classList.remove('hidden');
}
function closeSettingsModal() {
  document.getElementById('settingsModalOverlay').classList.add('hidden');
  document.getElementById('settingsModal').classList.add('hidden');
}
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('closeSettingsModal').addEventListener('click', closeSettingsModal);
document.getElementById('settingsModalOverlay').addEventListener('click', closeSettingsModal);

document.getElementById('settingsSaveBtn').addEventListener('click', () => {
  const f = readSettingsForm();
  const err = validateSettingsForm(f);
  if (err) return toast(err, true);
  applySettingsToState(f);
  scheduleSave();
  closeSettingsModal();
  toast('Settings saved');
});

document.getElementById('llmTestBtn').addEventListener('click', async () => {
  const f = readSettingsForm();
  if (!/^https?:\/\/[^\s/]+/.test(f.baseUrl) || !f.model) return toast('Fill in endpoint and model first', true);
  applySettingsToState(f);
  scheduleSave();
  const btn = document.getElementById('llmTestBtn');
  const result = document.getElementById('llmTestResult');
  btn.disabled = true;
  result.textContent = 'Testing…';
  result.className = 'settings-status';
  try {
    const res = await fetch('/api/import/test', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const note = data.hasModel ? '' : ` — model "${data.model}" not among ${data.models.length} listed`;
      result.textContent = '✓ Connected' + note;
      result.className = 'settings-status ok';
    } else {
      result.textContent = (data && data.error) || `Failed (HTTP ${res.status})`;
      result.className = 'settings-status err';
    }
  } catch (err) {
    result.textContent = 'Could not reach app server: ' + err.message;
    result.className = 'settings-status err';
  }
  btn.disabled = false;
});

/* ---------- statement import (PDF -> local LLM) ---------- */
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
}

let importAbort = null;
let importTimer = null;
let importT0 = 0;
let pendingPdf = null;

const IMPORT_STEPS = { pick: 'importStepPick', work: 'importStepWork', dup: 'importStepDup', error: 'importStepError', done: 'importStepDone' };
function showImportStep(name) {
  for (const [k, id] of Object.entries(IMPORT_STEPS)) {
    document.getElementById(id).classList.toggle('hidden', k !== name);
  }
}
function startImportTimer(label) {
  stopImportTimer();
  if (label) document.getElementById('importStatusText').textContent = label;
  importT0 = Date.now();
  importTimer = setInterval(() => {
    document.getElementById('importElapsed').textContent = Math.floor((Date.now() - importT0) / 1000) + 's elapsed';
  }, 500);
}
function stopImportTimer() {
  if (importTimer) { clearInterval(importTimer); importTimer = null; }
  document.getElementById('importElapsed').textContent = '';
}
function openImportModal() {
  showImportStep('pick');
  document.getElementById('importModalOverlay').classList.remove('hidden');
  document.getElementById('importModal').classList.remove('hidden');
}
function closeImportModal() {
  stopImportTimer();
  if (importAbort) { importAbort.abort(); importAbort = null; }
  pendingPdf = null;
  document.getElementById('importModalOverlay').classList.add('hidden');
  document.getElementById('importModal').classList.add('hidden');
}

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pdfTextLines(content) {
  const items = content.items.filter(it => typeof it.str === 'string');
  const lines = new Map();
  for (const it of items) {
    const y = Math.round(it.transform[5]);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push(it);
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) =>
    its.sort((a, b) => a.transform[4] - b.transform[4]).map(it => it.str).join(' ').trim()
  ).filter(l => l).join('\n');
}

async function extractPdfText(buf) {
  const data = new Uint8Array(buf);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += pdfTextLines(content) + '\n';
  }
  return text;
}

function currencyMismatch(text) {
  const app = (state.currency || '$').trim();
  if (!(app === '$' || /USD/i.test(app))) return null;
  const t = (text || '').slice(0, 4000);
  if (/€|EUR\b|EURO/.test(t)) return 'EUR (€)';
  if (/£|GBP\b|POUND/.test(t)) return 'GBP (£)';
  if (/₹|INR\b/.test(t)) return 'INR (₹)';
  const m = t.match(/\b(CAD|AED|SGD|AUD|JPY|CNY|CHF|HKD|KRW|MYR|PHP|SAR|BRL|MXN|ZAR|NOK|SEK|DKK)\b/);
  if (m) return m[1];
  return null;
}

function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function textTokens(s) {
  const t = new Set();
  for (const w of normText(s).split(' ')) if (w.length >= 3) t.add(w);
  return t;
}

function findDuplicate(row) {
  const amount = Math.abs(parseFloat(row.amount) || 0);
  if (amount <= 0) return null;
  const isIncome = row.type === 'income' || row.type === 'refund';
  const hay = isIncome ? (state.income || []) : (state.expenses || []);
  const rt = textTokens((row.description || '') + ' ' + (row.source || ''));
  if (!rt.size) return null;
  const d = row.date ? new Date(row.date + 'T00:00:00') : null;
  for (const t of hay) {
    if (Math.abs(Math.abs(parseFloat(t.amount) || 0) - amount) > 0.011) continue;
    if (d && t.date) {
      const td = new Date(t.date + 'T00:00:00');
      if (!isNaN(td) && Math.abs(d - td) > 3 * 86400000) continue;
    }
    const tt = textTokens((t.description || '') + ' ' + (t.source || ''));
    if (!tt.size) continue;
    let overlap = 0;
    for (const w of rt) if (tt.has(w)) overlap++;
    if (overlap / Math.min(rt.size, tt.size) >= 0.5) {
      return { date: t.date, description: t.description || t.source || 'existing row', amount: t.amount };
    }
  }
  return null;
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = [r.date || '', Math.abs(parseFloat(r.amount) || 0).toFixed(2), normText(r.description)].join('|');
    const prev = seen.get(key);
    if (!prev || (parseFloat(r.confidence) || 0) > (parseFloat(prev.confidence) || 0)) seen.set(key, r);
  }
  return [...seen.values()];
}

function renderImportHistory() {
  const box = document.getElementById('importHistory');
  const hist = (state.importedStatements || []).slice().reverse();
  if (!hist.length) {
    box.innerHTML = '<div class="hist-empty">No statements imported yet.</div>';
    return;
  }
  box.innerHTML = hist.map(h => `
    <div class="hist-row">
      <span class="hist-file">${escapeHtml(h.fileName || 'statement')}</span>
      <span class="hist-date">${escapeHtml(h.importedAt)}</span>
      <span class="hist-counts">${h.added} added${h.queued ? ' · ' + h.queued + ' to review' : ''}</span>
    </div>`).join('');
}

function commitImportedRow(r, kindOverride) {
  const k = kindOverride || ((r.type === 'income' || r.type === 'refund') ? 'income' : (r.type === 'transfer' ? null : 'expense'));
  if (!k) return false;
  const date = r.date || today();
  const amount = Math.abs(parseFloat(r.amount) || 0);
  if (amount <= 0) return false;
  if (k === 'income') {
    state.income.push({
      id: uid(), date, amount,
      source: r.source || (r.type === 'refund' ? 'Refund' : 'Imported'),
      tags: [],
      notes: r.description ? `Imported: ${r.description}` : 'Imported from statement',
      recurring: null,
    });
  } else {
    state.expenses.push({
      id: uid(), date, amount,
      category: r.category || 'Other',
      description: r.description,
      goalId: null, goalName: '',
      tags: [], notes: 'Imported from statement', recurring: null,
      groupId: null, _splitChild: false, account: null,
    });
  }
  return true;
}

async function startPdfImport(file, force) {
  showImportStep('work');
  startImportTimer('Reading PDF…');
  importAbort = new AbortController();
  try {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    if (!force) {
      const prior = (state.importedStatements || []).find(s => s.hash === hash);
      if (prior) {
        pendingPdf = { file, buf, hash };
        document.getElementById('importDupText').textContent =
          `This file was already imported on ${prior.importedAt} (${prior.added} added, ${prior.queued} queued). Import it again?`;
        showImportStep('dup');
        return;
      }
    }
    startImportTimer('Extracting text…');
    const rawText = await extractPdfText(buf);
    const text = (rawText || '').trim();
    if (text.replace(/\s+/g, '').length < 20) {
      showImportStep('error');
      document.getElementById('importErrorText').textContent = 'No selectable text found — this looks like a scanned (image-only) PDF. Only text-based statements are supported.';
      return;
    }
    const cur = currencyMismatch(text);
    startImportTimer('Parsing with your local model…');
    const res = await fetch('/api/import/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: importAbort.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.error) || `Server returned ${res.status}`);

    const th = (state.settings && state.settings.import && state.settings.import.confidenceThreshold != null)
      ? state.settings.import.confidenceThreshold : 0.85;
    const rawRows = data.transactions || [];
    const rows = dedupeRows(rawRows);
    const flagged = rows.map(r => ({ ...r, dupOf: findDuplicate(r) }));
    const isAuto = (r) => r.confidence >= th && r.type !== 'transfer' && !r.dupOf;
    const auto = flagged.filter(isAuto);
    const queued = flagged.filter(r => !isAuto(r));

    const snapshot = JSON.stringify({
      expenses: state.expenses, income: state.income,
      importQueue: state.importQueue, importedStatements: state.importedStatements,
    });
    for (const r of auto) commitImportedRow(r);
    state.importQueue = [...(state.importQueue || []), ...queued.map(r => ({ ...r, id: uid() }))];
    state.importedStatements = [...(state.importedStatements || []), {
      hash, fileName: file.name, importedAt: today(),
      added: auto.length, queued: queued.length,
    }];
    scheduleSave();
    render();

    recordChange('Statement imported', `${file.name} — ${auto.length} added, ${queued.length} to review`, () => {
      const snap = JSON.parse(snapshot);
      state.expenses = snap.expenses; state.income = snap.income;
      state.importQueue = snap.importQueue; state.importedStatements = snap.importedStatements;
      scheduleSave(); render();
    });

    const parts = [];
    if (data.statement) {
      const kind = data.statement.kind === 'credit_card' ? 'Credit card' : data.statement.kind === 'bank' ? 'Bank' : 'Statement';
      parts.push(kind + (data.statement.period ? ` · ${data.statement.period}` : ''));
    }
    parts.push(`${auto.length} added`);
    if (queued.length) parts.push(`${queued.length} to review`);
    if (rawRows.length > rows.length) parts.push(`${rawRows.length - rows.length} duplicate rows merged`);
    if (data.chunks > 1 && !data.partial) parts.push(`parsed in ${data.chunks} chunks`);
    if (data.partial) parts.push(`⚠ partial result — chunk(s) ${data.failedChunks.join(', ')} of ${data.chunks} failed`);
    if (cur) parts.push(`⚠ statement currency looks like ${cur} — amounts added as-is, not converted`);
    if (data.truncated) parts.push('⚠ very long statement — text was truncated');
    document.getElementById('importDoneSummary').textContent = parts.join('  ·  ');
    const list = document.getElementById('importDoneList');
    list.innerHTML = auto.slice(0, 30).map(r =>
      `<div class="done-row"><span>${escapeHtml(r.date || '—')}</span><span class="done-desc">${escapeHtml(r.description)}</span><span class="num">${fmt(r.amount)}</span><span class="done-type">${escapeHtml(r.type)}</span></div>`
    ).join('') + (auto.length > 30 ? `<div class="done-more">…and ${auto.length - 30} more</div>` : '');
    const revBtn = document.getElementById('importReviewBtn');
    revBtn.classList.toggle('hidden', queued.length === 0);
    revBtn.textContent = `Review ${queued.length} row${queued.length === 1 ? '' : 's'}`;
    showImportStep('done');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showImportStep('error');
      document.getElementById('importErrorText').textContent = 'Stopped waiting. The model may still be finishing in the background — that result is discarded.';
      return;
    }
    showImportStep('error');
    document.getElementById('importErrorText').textContent = (err && err.message) || 'Import failed.';
  } finally {
    stopImportTimer();
    importAbort = null;
  }
}

document.getElementById('importPdfBtn').addEventListener('click', () => openImportModal());
document.getElementById('closeImportModal').addEventListener('click', closeImportModal);
document.getElementById('importModalOverlay').addEventListener('click', closeImportModal);
document.getElementById('importDoneBtn').addEventListener('click', closeImportModal);
document.getElementById('importPickBtn').addEventListener('click', () => document.getElementById('importPdfFile').click());
document.getElementById('importPdfFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) startPdfImport(file, false);
});
document.getElementById('importDupBtn').addEventListener('click', () => {
  if (pendingPdf) startPdfImport(pendingPdf.file, true);
});
document.getElementById('importCancelBtn').addEventListener('click', () => {
  if (importAbort) importAbort.abort();
});
document.getElementById('importReviewBtn').addEventListener('click', () => {
  closeImportModal();
  switchTab('review');
});

/* ---------- review queue ---------- */
function updateReviewBadge() {
  const badge = document.getElementById('reviewBadge');
  const n = (state.importQueue || []).length;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

function renderReview() {
  const list = document.getElementById('reviewList');
  const queue = state.importQueue || [];
  updateReviewBadge();
  renderImportHistory();
  document.getElementById('approveAllBtn').classList.toggle('hidden', queue.length === 0);
  if (!queue.length) {
    list.innerHTML = '<div class="review-empty">Nothing to review. Import a statement PDF — low-confidence rows and transfers will wait here for your decision.</div>';
    return;
  }
  const cats = (state.categories && state.categories.length) ? state.categories : DEFAULT_CATEGORIES;
  list.innerHTML = queue.map(r => {
    const kind = (r.type === 'income' || r.type === 'refund') ? 'income' : (r.type === 'transfer' ? 'transfer' : 'expense');
    const dup = findDuplicate(r);
    return `
    <div class="review-row" data-rid="${escapeHtml(r.id)}">
      <div class="review-fields">
        <input type="date" class="rv-date" value="${escapeHtml(r.date) || today()}" />
        <input type="number" class="rv-amount" value="${r.amount}" step="0.01" min="0.01" />
        <select class="rv-type">
          <option value="expense" ${kind === 'expense' ? 'selected' : ''}>Expense</option>
          <option value="income" ${kind === 'income' ? 'selected' : ''}>Income</option>
          <option value="transfer" ${kind === 'transfer' ? 'selected' : ''}>Transfer (skip)</option>
        </select>
        <select class="rv-cat" ${kind === 'expense' ? '' : 'hidden'}>
          ${cats.map(c => `<option ${c === r.category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
        <input type="text" class="rv-source" value="${escapeHtml(r.source || '')}" placeholder="Source" ${kind === 'income' ? '' : 'hidden'} />
        <input type="text" class="rv-desc" value="${escapeHtml(r.description)}" placeholder="Description" />
      </div>
      <div class="review-meta">${Math.round((r.confidence || 0) * 100)}% confident</div>
      <div class="review-actions">
        <button class="primary-sm rv-approve">Approve</button>
        <button class="rv-skip">Skip</button>
      </div>
      ${dup ? `<div class="review-dup">⚠ Similar row already exists: ${escapeHtml(dup.description)} · ${fmt(dup.amount)} on ${escapeHtml(dup.date)}</div>` : ''}
    </div>`;
  }).join('');
}

function readReviewRow(row) {
  const val = (sel) => row.querySelector(sel).value.trim();
  const date = val('.rv-date');
  const kind = row.querySelector('.rv-type').value;
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(),
    amount: parseFloat(val('.rv-amount')),
    kind,
    category: row.querySelector('.rv-cat').value || 'Other',
    source: val('.rv-source') || (kind === 'income' ? 'Imported' : ''),
    description: val('.rv-desc'),
  };
}

function approveReviewRow(rid, rowEl) {
  const f = readReviewRow(rowEl);
  if (f.kind === 'transfer') {
    state.importQueue = (state.importQueue || []).filter(r => r.id !== rid);
    scheduleSave(); renderReview();
    toast('Transfer skipped — it does not count as income or spending');
    return;
  }
  if (isNaN(f.amount) || f.amount <= 0) return toast('Enter a valid amount', true);
  const snapshot = JSON.stringify({ expenses: state.expenses, income: state.income, importQueue: state.importQueue });
  const row = { date: f.date, amount: f.amount, type: f.kind, category: f.category, source: f.source, description: f.description };
  if (!commitImportedRow(row, f.kind)) return toast('Could not add row — check the amount', true);
  state.importQueue = (state.importQueue || []).filter(r => r.id !== rid);
  scheduleSave(); render();
  toast('Added');
  recordChange('Import row approved', `${f.description || f.source || 'row'} · ${fmt(f.amount)}`, () => {
    const snap = JSON.parse(snapshot);
    state.expenses = snap.expenses; state.income = snap.income; state.importQueue = snap.importQueue;
    scheduleSave(); render();
  });
}

function skipReviewRow(rid) {
  const snapshot = JSON.stringify(state.importQueue);
  state.importQueue = (state.importQueue || []).filter(r => r.id !== rid);
  scheduleSave(); renderReview();
  toast('Row skipped');
  recordChange('Import row skipped', 'Row returned to review queue', () => {
    state.importQueue = JSON.parse(snapshot);
    scheduleSave(); renderReview();
  });
}

document.getElementById('reviewList').addEventListener('change', (e) => {
  const row = e.target.closest('.review-row');
  if (!row || !e.target.classList.contains('rv-type')) return;
  const kind = e.target.value;
  row.querySelector('.rv-cat').hidden = kind !== 'expense';
  row.querySelector('.rv-source').hidden = kind !== 'income';
});

document.getElementById('reviewList').addEventListener('click', (e) => {
  const row = e.target.closest('.review-row');
  if (!row) return;
  const rid = row.dataset.rid;
  if (e.target.classList.contains('rv-approve')) approveReviewRow(rid, row);
  else if (e.target.classList.contains('rv-skip')) skipReviewRow(rid);
});

document.getElementById('approveAllBtn').addEventListener('click', () => {
  const queue = state.importQueue || [];
  const committable = queue.filter(r => r.type !== 'transfer');
  if (!queue.length) return;
  if (!committable.length) return toast('Only transfers left — they don\'t count as income or spending', true);
  const snapshot = JSON.stringify({ expenses: state.expenses, income: state.income, importQueue: state.importQueue });
  let added = 0;
  for (const r of committable) if (commitImportedRow(r)) added++;
  state.importQueue = queue.filter(r => r.type === 'transfer');
  scheduleSave(); render();
  toast(`Added ${added} row${added === 1 ? '' : 's'}`);
  recordChange('Import batch approved', `${added} rows added from review queue`, () => {
    const snap = JSON.parse(snapshot);
    state.expenses = snap.expenses; state.income = snap.income; state.importQueue = snap.importQueue;
    scheduleSave(); render();
  });
});

document.getElementById('addCatBtn').addEventListener('click', () => {
  const input = document.getElementById('newCatInput');
  const name = input.value.trim();
  if (!name) return toast('Enter a category name', true);
  const cats = state.categories.length ? state.categories : [...DEFAULT_CATEGORIES];
  if (cats.some(c => c.toLowerCase() === name.toLowerCase())) return toast('Category already exists', true);
  const addedCat = name;
  cats.push(name);
  state.categories = cats;
  input.value = '';
  scheduleSave();
  renderCatList();
  render();
  toast('Category added');
  recordChange('Category added', `${addedCat}`, () => { state.categories = state.categories.filter(c => c !== addedCat); scheduleSave(); renderCatList(); render(); });
});

document.getElementById('newCatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('addCatBtn').click();
  }
});

document.getElementById('catList').addEventListener('click', (e) => {
  const raw = e.target.getAttribute('data-del-cat');
  if (!raw) return;
  const cat = decodeURIComponent(raw);
  const cats = state.categories.length ? state.categories : [...DEFAULT_CATEGORIES];
  const remaining = cats.filter(c => c !== cat);
  if (!remaining.length) return toast('Cannot remove the last category', true);
  const removedCat = cat;
  state.categories = remaining;
  scheduleSave();
  renderCatList();
  render();
  toast(`Removed "${cat}"`);
  recordChange('Category removed', `${removedCat}`, () => { state.categories.push(removedCat); state.categories.sort((a, b) => a.localeCompare(b)); scheduleSave(); renderCatList(); render(); });
});

/* ---------- backups ---------- */
function openBackupModal() {
  document.getElementById('backupModalOverlay').classList.remove('hidden');
  document.getElementById('backupModal').classList.remove('hidden');
  loadBackupList();
}
function closeBackupModal() {
  document.getElementById('backupModalOverlay').classList.add('hidden');
  document.getElementById('backupModal').classList.add('hidden');
}

async function loadBackupList() {
  const list = document.getElementById('backupList');
  let data;
  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    data = await res.json();
  } catch {
    list.innerHTML = '<li class="empty">Could not load backups — is the server running?</li>';
    return;
  }
  if (!data.backups || !data.backups.length) {
    list.innerHTML = '<li class="empty">No backups yet</li>';
    return;
  }
  list.innerHTML = data.backups.map(b => {
    const raw = b.file.replace('moneywala-backup-', '').replace('.json', '');
    const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})/, 'T$1:$2:$3.$4');
    const d = new Date(iso);
    const ts = isNaN(d.getTime()) ? b.file : d.toLocaleString();
    return `<li><button class="backup-restore" data-backup="${b.file}">↻ ${ts}</button></li>`;
  }).join('');
}

document.getElementById('backupBtn').addEventListener('click', () => {
  openBackupModal();
});
document.getElementById('closeBackupModal').addEventListener('click', closeBackupModal);
document.getElementById('backupModalOverlay').addEventListener('click', closeBackupModal);

document.getElementById('backupList').addEventListener('click', async (e) => {
  const file = e.target.getAttribute('data-backup');
  if (!file) return;
  if (!confirm(`Restore backup from ${file}? Current data will be replaced.`)) return;
  try {
    const res = await fetch(`/api/backups/${file}`);
    const data = await res.json();
    const snapshot = JSON.parse(JSON.stringify(state));
    Object.assign(state, Object.assign(defaultData(), data));
    seedAndMigrate();
    state.alertsShown = state.alertsShown || {};
    document.getElementById('currencySelect').value = state.currency || '$';
    scheduleSave();
    render();
    closeBackupModal();
    toast('Backup restored');
    recordChange('Backup restored', `${file} — previous state restored on undo`, () => { Object.assign(state, snapshot); scheduleSave(); render(); });
  } catch {
    toast('Failed to restore backup', true);
  }
});

/* ---------- data versions & delete data ---------- */
function closeOptionsMenu() {
  document.getElementById('optionsMenu').classList.add('hidden');
  document.getElementById('menuOverlay').classList.add('hidden');
}

function openVersionsModal() {
  document.getElementById('versionsModalOverlay').classList.remove('hidden');
  document.getElementById('versionsModal').classList.remove('hidden');
  loadVersionList();
}
function closeVersionsModal() {
  document.getElementById('versionsModalOverlay').classList.add('hidden');
  document.getElementById('versionsModal').classList.add('hidden');
}

document.getElementById('versionsBtn').addEventListener('click', () => {
  closeOptionsMenu();
  openVersionsModal();
});
document.getElementById('closeVersionsModal').addEventListener('click', closeVersionsModal);
document.getElementById('versionsModalOverlay').addEventListener('click', closeVersionsModal);

function formatInstanceDate(created) {
  const [datePart, timePart] = String(created).split('_');
  const d = new Date(`${datePart}T${timePart ? timePart.replace(/-/g, ':') : '00:00:00'}`);
  return isNaN(d.getTime()) ? created : d.toLocaleString();
}

async function loadVersionList() {
  const list = document.getElementById('versionList');
  list.innerHTML = '<li class="empty">Loading…</li>';
  let data;
  try {
    const res = await fetch('/api/instances');
    data = await res.json();
  } catch {
    list.innerHTML = '<li class="empty">Could not load versions — is the server running?</li>';
    return;
  }
  if (!data.instances || !data.instances.length) {
    list.innerHTML = '<li class="empty">No saved versions yet. A version is saved each time you delete data.</li>';
    return;
  }
  list.innerHTML = data.instances.map(v => {
    const label = v.name ? `${escapeHtml(v.name)} · ${formatInstanceDate(v.created)}` : formatInstanceDate(v.created);
    return `<li><button class="backup-restore" data-version="${escapeHtml(v.file)}">📄 ${label}</button></li>`;
  }).join('');
}

document.getElementById('versionList').addEventListener('click', async (e) => {
  const file = e.target.getAttribute('data-version');
  if (!file) return;
  const label = e.target.textContent.replace(/^📄\s*/, '').trim();
  if (!confirm(`Load version "${label}"? Current data will be replaced.`)) return;
  try {
    const res = await fetch(`/api/instances/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    const snapshot = JSON.parse(JSON.stringify(state));
    Object.assign(state, Object.assign(defaultData(), data));
    seedAndMigrate();
    state.alertsShown = state.alertsShown || {};
    document.getElementById('currencySelect').value = state.currency || '$';
    scheduleSave();
    render();
    closeVersionsModal();
    toast('Version loaded');
    recordChange('Version loaded', `${label} — previous state restored on undo`, () => { Object.assign(state, snapshot); scheduleSave(); render(); });
  } catch {
    toast('Failed to load version', true);
  }
});

function openDeleteModal() {
  document.getElementById('versionNameInput').value = '';
  document.getElementById('deleteModalOverlay').classList.remove('hidden');
  document.getElementById('deleteModal').classList.remove('hidden');
  document.getElementById('versionNameInput').focus();
}
function closeDeleteModal() {
  document.getElementById('deleteModalOverlay').classList.add('hidden');
  document.getElementById('deleteModal').classList.add('hidden');
}
function closeResetDoneModal() {
  document.getElementById('resetDoneModalOverlay').classList.add('hidden');
  document.getElementById('resetDoneModal').classList.add('hidden');
}

document.getElementById('deleteDataBtn').addEventListener('click', () => {
  closeOptionsMenu();
  openDeleteModal();
});
document.getElementById('closeDeleteModal').addEventListener('click', closeDeleteModal);
document.getElementById('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
document.getElementById('deleteModalOverlay').addEventListener('click', closeDeleteModal);
document.getElementById('closeResetDoneModal').addEventListener('click', closeResetDoneModal);
document.getElementById('resetDoneOkBtn').addEventListener('click', closeResetDoneModal);
document.getElementById('versionNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('confirmDeleteBtn').click();
});

let deleteInFlight = false;
document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (deleteInFlight) return;
  deleteInFlight = true;
  const name = document.getElementById('versionNameInput').value.trim();
  closeDeleteModal();
  try {
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('version save failed');
    const inst = await res.json();
    const res2 = await fetch('/api/reset', { method: 'POST' });
    if (!res2.ok) throw new Error('reset failed');
    clearTimeout(saveTimer);
    saveStatus = 'saved';
    updateSaveIndicator();
    Object.assign(state, defaultData());
    seedAndMigrate();
    state.alertsShown = {};
    document.getElementById('currencySelect').value = state.currency || '$';
    history = [];
    render();
    const label = inst.name ? `"${inst.name}"` : `from ${formatInstanceDate(inst.created)}`;
    document.getElementById('resetDoneMsg').innerHTML =
      `All data has been reset. Your previous data is saved as version <b>${escapeHtml(label)}</b> — load it any time from <b>Data versions</b> in the ☰ menu.`;
    document.getElementById('resetDoneModalOverlay').classList.remove('hidden');
    document.getElementById('resetDoneModal').classList.remove('hidden');
  } catch {
    toast('Delete failed — your data was not changed', true);
  } finally {
    deleteInFlight = false;
  }
});

/* ---------- budget threshold alerts ---------- */
function checkBudgetAlerts() {
  const month = ym(today());
  const spent = expensesByCategory(month);
  state.budgets.forEach(b => {
    const s = spent[b.category] || 0;
    const pct = b.amount ? (s / b.amount) * 100 : 0;
    const key = b.id + '_' + month;
    if (pct >= 100 && !state.alertsShown[key + '_100']) {
      state.alertsShown[key + '_100'] = true;
      toast(`⚠ ${b.category} budget exceeded: ${fmt(s)} / ${fmt(b.amount)}`, true);
    } else if (pct >= 80 && pct < 100 && !state.alertsShown[key + '_80']) {
      state.alertsShown[key + '_80'] = true;
      toast(`⚠ ${b.category} at ${Math.round(pct)}% of budget`);
    }
  });
}

/* ---------- defaultData fallback ---------- */
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
    categories: [...DEFAULT_CATEGORIES],
  };
}

// After loading/restoring data, seed new arrays and migrate legacy inline
// recurring transactions into templates (dropping transient future instances).
function seedAndMigrate() {
  if (!state.categories || !state.categories.length) state.categories = [...DEFAULT_CATEGORIES];
  state.debts = Array.isArray(state.debts) ? state.debts : [];
  state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
  state.recurringTemplates = Array.isArray(state.recurringTemplates) ? state.recurringTemplates : [];
  state.importQueue = Array.isArray(state.importQueue) ? state.importQueue : [];
  state.importedStatements = Array.isArray(state.importedStatements) ? state.importedStatements : [];
  state.expenses = (state.expenses || []).filter(e => {
    if (e._generated) return false;
    if (e.recurring && !e._isTemplate) state.recurringTemplates.push(templateFromTransaction('expense', e));
    return true;
  });
  state.income = (state.income || []).filter(i => {
    if (i._generated) return false;
    if (i.recurring && !i._isTemplate) state.recurringTemplates.push(templateFromTransaction('income', i));
    return true;
  });
}

/* ---------- service worker (inert; exists only so old caching workers can be replaced) ---------- */
function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'moneywala-sw-migrated') location.reload();
    });
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('MoneyWala SW registered at', reg.scope))
      .catch(() => {});
  }
}

function showOfflineScreen() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  document.open();
  document.write('<!doctype html><meta charset="utf-8"><title>Moneywala</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#94a3b8;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}b{color:#e2e8f0}</style><div><b>MoneyWala server is not running.</b><br>This page is a saved copy and cannot save or load data.<br>Start the server (launcher.bat) and reload this page.</div>');
  document.close();
}

/* ---------- init ---------- */
async function init() {
  registerServiceWorker();
  document.getElementById('expDate').value = today();
  document.getElementById('incDate').value = today();
  setDashPreset('month');
  try {
    await loadData();
  } catch (err) {
    console.error('Failed to load data:', err);
    showOfflineScreen();
    return;
  }
  render();
  checkBudgetAlerts();
}
init();
