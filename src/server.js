const html = __HTML__;
const css = __CSS__;
const client = __CLIENT__;
const engine = __ENGINE__;

const BASE = 'https://fuyao.aicubes.cn';
const UNIVERSE = '000016.SH';
const METRICS = new Set(['revenue_yoy', 'profit_yoy', 'pe_ttm', 'pb_mrq', 'volatility_20d']);
__ACCOUNT__
let marketCache = null;
let marketPromise = null;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function fuyao(env, path, params, timeoutMs = 18000) {
  if (!env.FUYAO_API_KEY) throw new Error('金融数据服务尚未配置');
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'X-api-key': env.FUYAO_API_KEY, accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) {
      throw new Error(`${path} 返回 ${body.code ?? response.status}: ${body.message || '未知错误'}`);
    }
    return { data: body.data, requestId: body.request_id || null };
  } finally {
    clearTimeout(timer);
  }
}

async function limitedMap(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { ok: true, value: await task(items[index]) }; }
      catch (error) { results[index] = { ok: false, error: String(error?.message || error) }; }
    }
  }));
  return results;
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const chinaDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function date(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(chinaDateFormatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function metric(value, unit, source, extras = {}) {
  return { value: validNumber(value), unit, source, ...extras };
}

function growth(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current / previous) - 1) * 100;
}

function volatility(bars) {
  const closes = bars.map(row => validNumber(row.close_price)).filter(value => value !== null);
  if (closes.length < 21) return null;
  const last = closes.slice(-21);
  const returns = [];
  for (let index = 1; index < last.length; index++) {
    if (last[index - 1] <= 0) return null;
    returns.push(Math.log(last[index] / last[index - 1]));
  }
  const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

function normalize(universe, snapshotResult, valuationResult, incomeGroups, priceGroups, issues) {
  const snapshots = new Map((snapshotResult?.data?.item || []).map(row => [row.thscode, row]));
  const valuations = new Map((valuationResult?.data?.item || []).map(row => [row.thscode, row]));
  const incomes = new Map(incomeGroups.map(group => [group.thscode, group]));
  const histories = new Map(priceGroups.map(group => [group.thscode, group]));
  return universe.map(stock => {
    const code = stock.thscode;
    const incomeGroup = incomes.get(code);
    const rows = (incomeGroup?.item || []).filter(row => row?.period_end_ms && row?.report_date_ms && row.report_date_ms <= Date.now()).sort((a, b) => b.period_end_ms - a.period_end_ms);
    const latest = rows[0] || null;
    const comparable = latest ? rows.find(row => row.fiscal_year === latest.fiscal_year - 1 && row.fiscal_period === latest.fiscal_period) : null;
    const valuation = valuations.get(code);
    const history = histories.get(code);
    const bars = (history?.item || []).filter(row => row?.date_ms && row.date_ms <= Date.now()).sort((a, b) => a.date_ms - b.date_ms);
    const snap = snapshots.get(code);
    const incomeSource = {
      provider: '扶摇金融数据', endpoint: '/api/a-share/financials/income-statements-batch',
      requestId: incomeGroup?._requestId || null,
      reportEnd: date(latest?.period_end_ms), published: date(latest?.report_date_ms),
      priorReportEnd: date(comparable?.period_end_ms), priorPublished: date(comparable?.report_date_ms),
      method: '同一财报期间的本年字段值 ÷ 上年同期字段值 − 1；上年值≤0时记为缺失',
    };
    const valuationSource = {
      provider: '扶摇金融数据', endpoint: '/api/a-share/valuations/snapshot',
      requestId: valuationResult?.requestId || null,
      asOf: date(valuationResult?.data?.timestamp), method: '接口原始估值；TTM 为近十二个月，MRQ 为最新报告期',
    };
    const historySource = {
      provider: '扶摇金融数据', endpoint: '/api/a-share/prices/historical-batch',
      requestId: history?._requestId || null, asOf: date(bars.at(-1)?.date_ms),
      method: '前复权日收盘价最近21个点的20个对数收益率，样本标准差 × √252，单位%',
    };
    return {
      code, name: stock.name || snap?.name || valuation?.name || code,
      latestPrice: validNumber(snap?.last_price),
      priceAsOf: date(snapshotResult?.data?.timestamp),
      metrics: {
        revenue_yoy: metric(growth(latest?.operating_income, comparable?.operating_income), '%', incomeSource, {
          raw: { currentField: 'operating_income', current: validNumber(latest?.operating_income), priorField: 'operating_income', prior: validNumber(comparable?.operating_income), currency: latest?.currency || 'CNY' },
        }),
        profit_yoy: metric(growth(latest?.parent_holder_net_profit, comparable?.parent_holder_net_profit), '%', incomeSource, {
          raw: { currentField: 'parent_holder_net_profit', current: validNumber(latest?.parent_holder_net_profit), priorField: 'parent_holder_net_profit', prior: validNumber(comparable?.parent_holder_net_profit), currency: latest?.currency || 'CNY' },
        }),
        pe_ttm: metric(valuation?.pe_ttm, '倍', valuationSource, { raw: { field: 'pe_ttm', value: validNumber(valuation?.pe_ttm) } }),
        pb_mrq: metric(valuation?.pb_mrq, '倍', valuationSource, { raw: { field: 'pb_mrq', value: validNumber(valuation?.pb_mrq) } }),
        volatility_20d: metric(volatility(bars), '%', historySource, { raw: { closeField: 'close_price', pricePoints: bars.length, adjust: 'forward', interval: '1d' } }),
      },
      missing: issues.filter(issue => issue.codes.includes(code)).map(issue => issue.message),
    };
  });
}

async function loadMarket(env) {
  const universeResult = await fuyao(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: UNIVERSE });
  const universe = universeResult.data.item || [];
  if (universe.length < 40 || universe.length > 60) throw new Error(`上证50成分数量异常：${universe.length}`);
  const codes = universe.map(item => item.thscode);
  const batches = chunks(codes, 10);
  const priceStart = Date.now() - 125 * 86400000;
  const priceEnd = Date.now();
  const jobs = [
    { type: 'snapshot', codes, path: '/api/a-share/prices/snapshot', params: { thscodes: codes.join(',') } },
    { type: 'valuation', codes, path: '/api/a-share/valuations/snapshot', params: { thscodes: codes.join(',') } },
    ...batches.map(batch => ({ type: 'income', codes: batch, path: '/api/a-share/financials/income-statements-batch', params: { thscodes: batch.join(','), period: 'quarterly', limit: 12 } })),
    ...batches.map(batch => ({ type: 'history', codes: batch, path: '/api/a-share/prices/historical-batch', params: { thscodes: batch.join(','), interval: '1d', adjust: 'forward', start: priceStart, end: priceEnd } })),
  ];
  const done = await limitedMap(jobs, 4, job => fuyao(env, job.path, job.params, 25000));
  const issues = [];
  let snapshotResult = null;
  let valuationResult = null;
  const incomeGroups = [];
  const priceGroups = [];
  done.forEach((result, index) => {
    const job = jobs[index];
    if (!result.ok) {
      issues.push({ type: job.type, codes: job.codes, message: `${job.type}：${result.error}` });
      return;
    }
    const value = result.value;
    if (job.type === 'snapshot') snapshotResult = value;
    if (job.type === 'valuation') valuationResult = value;
    if (job.type === 'income') incomeGroups.push(...(value.data.item || []).map(group => ({ ...group, _requestId: value.requestId })));
    if (job.type === 'history') priceGroups.push(...(value.data.item || []).map(group => ({ ...group, _requestId: value.requestId })));
  });
  return {
    universe: '上证50', universeCode: UNIVERSE, universeCount: universe.length,
    universeAsOf: date(universeResult.data.timestamp), fetchedAt: new Date().toISOString(),
    stocks: normalize(universe, snapshotResult, valuationResult, incomeGroups, priceGroups, issues),
    issues: issues.map(({ type, codes, message }) => ({ type, affected: codes.length, message })),
    toolFootprint: ['snapshot', 'valuation', 'income', 'history'].map(type => ({
      type, requests: jobs.filter(job => job.type === type).length,
      succeeded: jobs.filter((job, index) => job.type === type && done[index].ok).length,
    })),
    notes: ['数据为当前接口快照，财务报告期与行情时点可能不同。', '当前不做历史回测，不把今天的成分与数据用于过去的策略收益计算。'],
  };
}

async function loadSharedMarket(env) {
  const database = db(env);
  const started = Date.now();
  const owner = crypto.randomUUID();
  const acquired = await database.prepare("INSERT INTO market_cache (id, data_json, fetched_at, lease_until, lease_owner) VALUES (1, '{}', 0, ?, ?) ON CONFLICT(id) DO UPDATE SET lease_until = excluded.lease_until, lease_owner = excluded.lease_owner WHERE market_cache.lease_until < ?").bind(started + 120000, owner, started).run();
  if (acquired.meta?.changes) {
    try {
      const data = await loadMarket(env);
      const fetchedAt = Date.now();
      await database.prepare('UPDATE market_cache SET data_json = ?, fetched_at = ?, lease_until = 0, lease_owner = NULL WHERE id = 1 AND lease_owner = ?').bind(JSON.stringify(data), fetchedAt, owner).run();
      return { data, fetchedAt, cache: 'fresh' };
    } catch (error) {
      await database.prepare('UPDATE market_cache SET lease_until = 0, lease_owner = NULL WHERE id = 1 AND lease_owner = ?').bind(owner).run();
      throw error;
    }
  }
  for (let attempt = 0; attempt < 45; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const row = await database.prepare('SELECT data_json, fetched_at, lease_until FROM market_cache WHERE id = 1').first();
    if (row && row.lease_until === 0 && row.fetched_at >= started - 1000 && row.fetched_at <= Date.now()) return { data: JSON.parse(row.data_json), fetchedAt: row.fetched_at, cache: 'shared' };
    if (row && row.lease_until === 0) break;
  }
  throw new Error('共享数据刷新未完成，请稍后重试');
}

async function interpret(request, env) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : '';
  const followUps = (Array.isArray(body.followUps) ? body.followUps : []).slice(0, 3).map(item => String(item).trim().slice(0, 200)).filter(Boolean);
  if (!text) return json({ error: '请输入选股意图' }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: 'AI 解析服务尚未配置' }, 503);
  const system = `你是选股意图理解与澄清助手，只输出 JSON 对象，不输出股票、预测、买卖建议。股票池固定上证50。允许的 metric 仅有 revenue_yoy（营业收入同比增长率%）、profit_yoy（归母净利润同比增长率%）、pe_ttm（市盈率TTM倍）、pb_mrq（市净率MRQ倍）、volatility_20d（近20交易日年化波动率%）。每个 condition 为 {"metric":"...","op":"gte|lte|gt|lt|between","value":数值,"max":数值可选,"label":"简短中文解释"}。你会收到原始意图及后续补充，后续补充可修正原始描述；需综合理解，而不是只解析最后一句。模糊的经营改善默认 revenue_yoy>0 且 profit_yoy>0；估值合理默认两条条件 pe_ttm>0 与 pe_ttm<=30，并在 assumptions 中说明这只是用户可改的工作假设；走势稳定默认 volatility_20d<=30，同样说明假设。若用户给出明确阈值，按阈值。不能由这5个字段表达的要求放入 unsupported，绝不悄悄忽略。重要信息不足、含义含糊或语义冲突时，在 clarifications 中提出最多两个简短、可回答的问题；冲突条件仍保留供用户检查。输出键：conditions 数组、assumptions 字符串数组、unsupported 字符串数组、clarifications 字符串数组。最多8条条件。`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0, max_tokens: 900, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ originalIntent: text, userFollowUps: followUps }) }] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}`);
    const parsed = JSON.parse(result.choices?.[0]?.message?.content || '{}');
    const conditions = (Array.isArray(parsed.conditions) ? parsed.conditions : []).slice(0, 8).filter(item => {
      return item && METRICS.has(item.metric) && ['gte', 'lte', 'gt', 'lt', 'between'].includes(item.op) && Number.isFinite(item.value) && (item.op !== 'between' || Number.isFinite(item.max));
    }).flatMap(item => item.metric === 'pe_ttm' && item.op === 'between' && item.value === 0
      ? [{ metric: 'pe_ttm', op: 'gt', value: 0, label: '市盈率为正' }, { metric: 'pe_ttm', op: 'lte', value: item.max, label: String(item.label || '').slice(0, 80) }]
      : [{ metric: item.metric, op: item.op, value: item.value, ...(item.op === 'between' ? { max: item.max } : {}), label: String(item.label || '').slice(0, 80) }]).slice(0, 8);
    return json({ conditions, assumptions: stringList(parsed.assumptions), unsupported: stringList(parsed.unsupported), clarifications: stringList(parsed.clarifications), model: result.model || 'deepseek-chat' });
  } catch (error) {
    return json({ error: `AI 解析失败：${error?.message || '未知错误'}` }, 502);
  } finally { clearTimeout(timer); }
}

function stringList(value) { return (Array.isArray(value) ? value : []).slice(0, 8).map(item => String(item).slice(0, 160)); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
    if (url.pathname === '/app.js') return new Response(client, { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    if (url.pathname === '/engine.js') return new Response(engine, { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (Number(request.headers.get('content-length') || 0) > 8192) return json({ error: '请求内容过大' }, 413);
    try {
      if (url.pathname === '/api/session' || url.pathname === '/api/account' || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/strategies')) return await accountRoute(request, env, url);
      const user = await currentUser(request, env);
      if (!user) return json({ error: '请先注册或登录账号' }, 401);
      if (url.pathname === '/api/interpret' && request.method === 'POST') {
        if (!sameOrigin(request)) return json({ error: '跨站请求被拒绝' }, 403);
        if (!await rateLimit(db(env), `ai:${user.id}`, 20, 86400000)) return json({ error: '今日 AI 解析次数已达上限，可继续手动修改条件。' }, 429);
        return interpret(request, env);
      }
      if (url.pathname === '/api/market' && request.method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1';
        if (refresh) {
          if (!await rateLimit(db(env), `refresh:${user.id}`, 2, 3600000)) return json({ error: '本小时刷新次数已达上限，请稍后重试' }, 429);
          marketCache = null;
        }
        if (!refresh && marketCache && Date.now() - marketCache.time < 15 * 60 * 1000) return json({ ...marketCache.data, cache: 'memory' });
        if (!refresh) {
          const cached = await db(env).prepare('SELECT data_json, fetched_at FROM market_cache WHERE id = 1').first();
          if (cached && Date.now() - cached.fetched_at < 15 * 60 * 1000) {
            const data = JSON.parse(cached.data_json);
            marketCache = { data, time: cached.fetched_at };
            return json({ ...data, cache: 'database' });
          }
        }
        if (!marketPromise) marketPromise = loadSharedMarket(env).finally(() => { marketPromise = null; });
        try {
          const result = await marketPromise;
          marketCache = { data: result.data, time: result.fetchedAt };
          return json({ ...result.data, cache: result.cache });
        } catch (error) { return json({ error: `金融数据获取失败：${error?.message || '未知错误'}` }, 502); }
      }
    } catch (error) {
      console.error('MINGSHAI_API_ERROR', url.pathname, error?.name || 'Error', error?.message || 'unknown');
      return json({ error: /数据库尚未连接/.test(String(error?.message)) ? '账号数据库暂不可用' : '服务暂不可用，请稍后重试' }, 503);
    }
    return new Response('Not found', { status: 404 });
  },
};
