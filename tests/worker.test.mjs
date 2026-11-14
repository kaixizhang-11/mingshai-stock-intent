import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { createLocalDb } from '../scripts/local-db.mjs';

async function signedIn(email = 'test@example.com') {
  const DB = createLocalDb();
  const response = await worker.fetch(new Request('https://example.test/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'strong-passphrase-123' }) }), { DB });
  assert.equal(response.status, 201);
  return { DB, cookie: response.headers.get('set-cookie').split(';')[0] };
}

const codes = Array.from({ length: 50 }, (_, index) => `${String(600000 + index)}.SH`);
const universe = codes.map((thscode, index) => ({ thscode, name: `测试公司${index + 1}` }));
const bars = Array.from({ length: 25 }, (_, index) => ({ date_ms: Date.UTC(2026, 9, index + 1), close_price: 100 + index * 0.1 }));
const income = thscode => ({ thscode, timestamp: Date.now(), item: [
  { fiscal_year: 2026, fiscal_period: 'Q3', period_end_ms: Date.UTC(2026, 8, 30), report_date_ms: Date.UTC(2026, 9, 30), operating_income: 120, parent_holder_net_profit: 22, currency: 'CNY' },
  { fiscal_year: 2025, fiscal_period: 'Q3', period_end_ms: Date.UTC(2025, 8, 30), report_date_ms: Date.UTC(2025, 9, 30), operating_income: 100, parent_holder_net_profit: 20, currency: 'CNY' },
] });

function fakeFetch({ failedIncome = false, missingValuation = false } = {}) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.deepseek.com') return new Response(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: JSON.stringify({ conditions: [{ metric: 'revenue_yoy', op: 'gt', value: 0 }, { metric: 'made_up', op: 'gt', value: 1 }], assumptions: ['测试假设'], unsupported: ['未来股价'], clarifications: [] }) } }] }), { status: 200 });
    const batch = (url.searchParams.get('thscodes') || '').split(',').filter(Boolean);
    let data;
    if (url.pathname.endsWith('/ths-stock-list')) data = { timestamp: Date.now(), item: universe };
    else if (url.pathname.endsWith('/prices/snapshot')) data = { timestamp: Date.now(), item: batch.map(thscode => ({ thscode, last_price: 10 })) };
    else if (url.pathname.endsWith('/valuations/snapshot')) data = { timestamp: Date.now(), item: batch.map((thscode, index) => ({ thscode, pe_ttm: missingValuation && index === 0 ? null : 20, pb_mrq: 2 })) };
    else if (url.pathname.endsWith('/income-statements-batch')) {
      if (failedIncome && batch.includes(codes[0])) return new Response(JSON.stringify({ code: 5002, message: 'upstream timeout', data: null }), { status: 200 });
      data = { item: batch.map(income) };
    } else if (url.pathname.endsWith('/historical-batch')) data = { item: batch.map(thscode => ({ thscode, timestamp: Date.now(), item: bars })) };
    else throw new Error(`Unexpected URL: ${url.pathname}`);
    return new Response(JSON.stringify({ code: 0, message: 'success', request_id: 'test-request', data }), { status: 200 });
  };
}

test('market route returns 50 traceable stocks and preserves null valuation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ missingValuation: true });
  try {
    const { DB, cookie } = await signedIn();
    const response = await worker.fetch(new Request('https://example.test/api/market', { headers: { cookie } }), { DB, FUYAO_API_KEY: 'test' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.stocks.length, 50);
    assert.equal(body.issues.length, 0);
    assert.ok(Math.abs(body.stocks[0].metrics.revenue_yoy.value - 20) < 1e-9);
    assert.ok(Math.abs(body.stocks[0].metrics.profit_yoy.value - 10) < 1e-9);
    assert.equal(body.stocks[0].metrics.pe_ttm.value, null);
    assert.equal(body.stocks[0].metrics.revenue_yoy.raw.currentField, 'operating_income');
    assert.equal(body.stocks[0].metrics.revenue_yoy.source.requestId, 'test-request');
  } finally { globalThis.fetch = originalFetch; }
});

test('partial financial API failure leaves affected stocks unknown', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ failedIncome: true });
  try {
    const { DB, cookie } = await signedIn();
    const response = await worker.fetch(new Request('https://example.test/api/market?refresh=1', { headers: { cookie } }), { DB, FUYAO_API_KEY: 'test' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.issues.length, 1);
    assert.equal(body.issues[0].affected, 10);
    assert.equal(body.stocks[0].metrics.revenue_yoy.value, null);
    assert.equal(body.stocks[0].metrics.profit_yoy.value, null);
    assert.ok(body.stocks[0].missing.length > 0);
    assert.ok(Math.abs(body.stocks[10].metrics.revenue_yoy.value - 20) < 1e-9);
  } finally { globalThis.fetch = originalFetch; }
});

test('AI interpretation only accepts supported metrics and reports unsupported intent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  try {
    const { DB, cookie } = await signedIn();
    const response = await worker.fetch(new Request('https://example.test/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text: '经营改善，未来一定涨' }) }), { DB, DEEPSEEK_API_KEY: 'test' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.conditions.map(item => item.metric), ['revenue_yoy']);
    assert.deepEqual(body.unsupported, ['未来股价']);
  } finally { globalThis.fetch = originalFetch; }
});

test('missing data credential fails visibly', async () => {
  const { DB, cookie } = await signedIn();
  const response = await worker.fetch(new Request('https://example.test/api/market?refresh=1', { headers: { cookie } }), { DB });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.error, /尚未配置/);
});
