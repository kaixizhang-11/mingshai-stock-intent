import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent } from '../src/intent.js';

const mapped = (text, metrics) => ({ text, status: 'mapped', reason: '明确的量化口径', metrics });
const condition = (metric, op, value) => ({ metric, op, value, label: '测试条件' });

test('ambiguous stable earning request cannot produce candidate stocks from a partial proxy', () => {
  const result = validateIntent({ requirements: [mapped('股价稳定', ['volatility_20d'])], conditions: [condition('volatility_20d', 'lte', 30)] }, '想找稳定赚钱的股票');
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.blockers.join(' '), /含义不明确/);
  assert.ok(result.clarifications.length);
});

test('explicit clarification of consecutive profitability and volatility can execute', () => {
  const result = validateIntent({ requirements: [mapped('连续三年盈利', ['profitable_years_3y']), mapped('股价波动较低', ['volatility_20d'])], conditions: [condition('profitable_years_3y', 'gte', 3), condition('volatility_20d', 'lte', 30)] }, '想找稳定赚钱的股票', ['我指公司连续三年盈利，股价20日年化波动率不超过30%']);
  assert.equal(result.status, 'ready');
});

test('user rejecting guaranteed returns is context, not a missing financial metric', () => {
  const result = validateIntent({ requirements: [mapped('公司近三年每年持续盈利', ['profitable_years_3y']), mapped('股价波动较低', ['volatility_20d']), mapped('不要求未来收益保证', [])], conditions: [condition('profitable_years_3y', 'gte', 3), condition('volatility_20d', 'lte', 30)] }, '想找稳定赚钱的股票', ['我指公司近三年持续盈利，20日年化波动率不超过30%，不要求未来收益保证']);
  assert.equal(result.status, 'ready');
  assert.equal(result.requirements[2].status, 'context');
});

test('unsupported clause and unmapped model output fail closed', () => {
  const unsupported = validateIntent({ requirements: [mapped('低波动', ['volatility_20d']), { text: '稳定分红', status: 'unsupported', reason: '未取到分红数据', metrics: [] }], conditions: [condition('volatility_20d', 'lte', 30)], unsupported: ['稳定分红'] }, '低波动并且稳定分红');
  assert.equal(unsupported.status, 'needs_clarification');
  assert.equal(validateIntent({ conditions: [condition('pe_ttm', 'lte', 30)] }, '便宜的股票').status, 'needs_clarification');
});
