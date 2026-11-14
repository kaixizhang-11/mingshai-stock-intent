import test from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, evaluateStock } from '../src/engine.js';

const stock = (revenue, profit, pe) => ({ code: '600001.SH', metrics: { revenue_yoy: { value: revenue }, profit_yoy: { value: profit }, pe_ttm: { value: pe } } });

test('deterministic engine separates pass, exclusion and missing evidence', () => {
  const conditions = [
    { metric: 'revenue_yoy', op: 'gt', value: 0 },
    { metric: 'profit_yoy', op: 'gt', value: 0 },
    { metric: 'pe_ttm', op: 'lte', value: 30 },
  ];
  assert.equal(evaluateStock(stock(8, 3, 20), conditions).status, 'pass');
  const excluded = evaluateStock(stock(8, -1, 20), conditions);
  assert.equal(excluded.status, 'fail');
  assert.equal(excluded.checks[1].status, 'fail');
  const missing = evaluateStock(stock(8, null, 20), conditions);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.checks[1].status, 'unknown');
  assert.equal(evaluateStock(stock(8, null, 40), conditions).status, 'fail');
});

test('conflicting bounds prevent execution', () => {
  assert.match(findConflicts([{ metric: 'pe_ttm', op: 'gt', value: 40 }, { metric: 'pe_ttm', op: 'lt', value: 20 }])[0], /市盈率/);
  assert.match(findConflicts([{ metric: 'revenue_yoy', op: 'between', value: 15, max: 5 }])[0], /下限/);
  assert.equal(findConflicts([{ metric: 'pe_ttm', op: 'gt', value: 0 }, { metric: 'pe_ttm', op: 'lte', value: 30 }]).length, 0);
  assert.match(findConflicts([{ metric: 'pe_ttm', op: 'lte', value: NaN }])[0], /阈值不是有效数字/);
});
