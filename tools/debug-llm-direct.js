const t0 = Date.now();
const body = {
  model: 'qwen3.8:27b-q4_K_M',
  temperature: 0,
  max_tokens: 16000,
  stream: false,
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false },
  messages: [
    { role: 'system', content: 'You extract bank statement rows. Reply with JSON only.' },
    { role: 'user', content: 'Rows:\nMar 27 UBER * TRIP 104.50\nMar 28 DIRECT DEPOSIT SALARY 2450.00\nYear hint: 2026\nReply {"transactions":[{"date":"YYYY-MM-DD","description":"...","amount":N,"type":"expense|income|transfer|fee|refund"}]}' },
  ],
};
fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  signal: AbortSignal.timeout(240000),
}).then(async (r) => {
  const t = await r.text();
  console.log('HTTP', r.status, 'ms', Date.now() - t0);
  console.log(t.slice(0, 800));
}).catch((e) => console.error('FETCH FAIL:', e.message));
