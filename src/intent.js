// The model proposes a plan. This validator decides whether the plan may run.
export const EXECUTABLE_METRICS = new Set([
  'revenue_yoy', 'profit_yoy', 'pe_ttm', 'pb_mrq', 'volatility_20d',
  'profitable_years_3y',
]);
const OPS = new Set(['gte', 'lte', 'gt', 'lt', 'between']);
const PROMISE = /稳定赚钱|稳赚|保本|保证.{0,8}收益|无风险|零风险|稳赚不赔|必涨/;
const REFRAME = /持续盈利|连续盈利|连续.{0,3}年.{0,3}盈利|近.{0,3}年.{0,3}盈利|利润|经营|财务|股价波动|波动率|分红|现金流/;

export function validateIntent(raw, original, followUps = []) {
  const conditions = (Array.isArray(raw?.conditions) ? raw.conditions : []).slice(0, 8)
    .filter(c => c && EXECUTABLE_METRICS.has(c.metric) && OPS.has(c.op)
      && Number.isFinite(c.value) && (c.op !== 'between' || Number.isFinite(c.max)))
    .map(c => ({ metric: c.metric, op: c.op, value: c.value,
      ...(c.op === 'between' ? { max: c.max } : {}), label: String(c.label || '').slice(0, 80) }));
  const list = value => (Array.isArray(value) ? value : []).slice(0, 8).map(x => String(x).slice(0, 160)).filter(Boolean);
  const requirements = (Array.isArray(raw?.requirements) ? raw.requirements : []).slice(0, 8)
    .filter(r => r && typeof r.text === 'string' && ['mapped', 'clarify', 'unsupported', 'context'].includes(r.status))
    .map(r => ({ text: r.text.slice(0, 120), status: r.status === 'mapped' &&
      /^(?:我)?(?:不要求|无需|不需要|不追求).{0,12}(?:未来)?(?:收益保证|保证收益|收益承诺|涨跌预测)/.test(r.text) ? 'context' : r.status,
      reason: String(r.reason || '').slice(0, 160),
      metrics: (Array.isArray(r.metrics) ? r.metrics : []).filter(x => EXECUTABLE_METRICS.has(x)) }));
  const clarifications = list(raw?.clarifications);
  const unsupported = list(raw?.unsupported);
  const assumptions = list(raw?.assumptions);
  const reasons = [];
  if (!requirements.length) reasons.push('AI 未给出逐项需求覆盖表，不能确认是否理解完整。');
  if (requirements.some(r => r.status !== 'mapped' && r.status !== 'context')) reasons.push('有需求尚未转成可执行条件。');
  if (clarifications.length) reasons.push('用户意图仍有待澄清的问题。');
  if (unsupported.length) reasons.push('当前数据能力未覆盖全部需求。');
  if (requirements.some(r => r.status === 'mapped' && (!r.metrics.length || r.metrics.some(m => !conditions.some(c => c.metric === m))))) reasons.push('需求与实际条件未逐项对应。');
  if (PROMISE.test(original) && !followUps.some(x => REFRAME.test(x))) {
    reasons.push('“稳定赚钱”或保证收益的含义不明确，且未来收益无法保证。请明确你要研究持续盈利、价格波动还是分红。');
    if (!clarifications.length) clarifications.push('你指公司近几年持续盈利、股价波动较低，还是稳定分红？想看几年？');
  }
  if (!conditions.length) reasons.push('没有可执行条件。');
  return { status: reasons.length ? 'needs_clarification' : 'ready', conditions, requirements,
    clarifications, unsupported, assumptions, blockers: [...new Set(reasons)] };
}
