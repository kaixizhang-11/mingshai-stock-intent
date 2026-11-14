const METRIC_NAMES = {
  revenue_yoy: '营业收入同比',
  profit_yoy: '归母净利润同比',
  pe_ttm: '市盈率 TTM',
  pb_mrq: '市净率 MRQ',
  volatility_20d: '20 日年化波动率',
};

export function findConflicts(conditions) {
  const errors = [];
  for (const [metric, name] of Object.entries(METRIC_NAMES)) {
    let low = -Infinity, high = Infinity, lowInclusive = true, highInclusive = true;
    for (const c of conditions.filter(item => item.metric === metric)) {
      if (!Number.isFinite(c.value) || (c.op === 'between' && !Number.isFinite(c.max))) { errors.push(`${name} 的阈值不是有效数字`); continue; }
      if (c.op === 'between' && c.value > c.max) errors.push(`${name} 的区间下限高于上限`);
      const lowers = c.op === 'gt' || c.op === 'gte' || c.op === 'between';
      const uppers = c.op === 'lt' || c.op === 'lte' || c.op === 'between';
      if (lowers && (c.value > low || (c.value === low && c.op === 'gt'))) { low = c.value; lowInclusive = c.op !== 'gt'; }
      const top = c.op === 'between' ? c.max : c.value;
      if (uppers && (top < high || (top === high && c.op === 'lt'))) { high = top; highInclusive = c.op !== 'lt'; }
    }
    if (low > high || (low === high && (!lowInclusive || !highInclusive))) errors.push(`${name} 同时要求高于 ${low} 且低于 ${high}`);
  }
  return [...new Set(errors)];
}

export function check(stock, condition) {
  const value = stock.metrics?.[condition.metric]?.value;
  if (!Number.isFinite(value)) return 'unknown';
  const target = condition.value;
  if (condition.op === 'gt') return value > target ? 'pass' : 'fail';
  if (condition.op === 'gte') return value >= target ? 'pass' : 'fail';
  if (condition.op === 'lt') return value < target ? 'pass' : 'fail';
  if (condition.op === 'lte') return value <= target ? 'pass' : 'fail';
  if (condition.op === 'between') return value >= target && value <= condition.max ? 'pass' : 'fail';
  return 'unknown';
}

export function evaluateStock(stock, conditions) {
  const checks = conditions.map(condition => ({ condition, status: check(stock, condition) }));
  const status = checks.some(item => item.status === 'fail') ? 'fail' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'pass';
  return { stock, checks, status };
}
