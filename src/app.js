import { findConflicts, evaluateStock } from '/engine.js';

const FIELDS = {
  revenue_yoy: { name: '营业收入同比', short: '营收同比', unit: '%', doc: 'https://fuyao.aicubes.cn/docs/api-reference/financials/' },
  profit_yoy: { name: '归母净利润同比', short: '利润同比', unit: '%', doc: 'https://fuyao.aicubes.cn/docs/api-reference/financials/' },
  pe_ttm: { name: '市盈率 TTM', short: 'PE TTM', unit: '倍', doc: 'https://fuyao.aicubes.cn/docs/api-reference/valuations/' },
  pb_mrq: { name: '市净率 MRQ', short: 'PB MRQ', unit: '倍', doc: 'https://fuyao.aicubes.cn/docs/api-reference/valuations/' },
  volatility_20d: { name: '20 日年化波动率', short: '20日波动', unit: '%', doc: 'https://fuyao.aicubes.cn/docs/api-reference/prices/' },
};
const OPERATORS = { gt: '>', gte: '≥', lt: '<', lte: '≤', between: '区间' };
const DEFAULTS = [
  { metric: 'revenue_yoy', op: 'gt', value: 0, label: '经营改善：营业收入同比为正' },
  { metric: 'profit_yoy', op: 'gt', value: 0, label: '经营改善：归母净利润同比为正' },
  { metric: 'pe_ttm', op: 'gt', value: 0, label: '估值口径：剔除非正市盈率' },
  { metric: 'pe_ttm', op: 'lte', value: 30, label: '估值合理暂按 PE TTM ≤ 30 倍' },
  { metric: 'volatility_20d', op: 'lte', value: 30, label: '稳定暂按近 20 日年化波动率 ≤ 30%' },
];
const state = { user: null, market: null, conditions: structuredClone(DEFAULTS), assumptions: ['“估值合理”暂以 PE TTM 0–30 倍表达；“稳定”暂以 20 日年化波动率不超过 30% 表达。两项均为可修改的工作假设。'], unsupported: [], clarifications: [], intentBase: '', followUps: [], tab: 'pass', results: [], compare: new Set(), previousPass: null, loading: false, strategies: [] };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const num = (value, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value) : '—';
const asDateTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 3300);
}

function showAuth() {
  state.user = null;
  state.market = null;
  state.results = [];
  state.conditions = structuredClone(DEFAULTS);
  state.assumptions = [];
  state.unsupported = [];
  state.clarifications = [];
  state.intentBase = '';
  state.followUps = [];
  state.compare.clear();
  state.strategies = [];
  state.previousPass = null;
  state.tab = 'pass';
  document.querySelectorAll('.tab').forEach(tab => { tab.classList.toggle('active', tab.dataset.tab === 'pass'); tab.setAttribute('aria-selected', String(tab.dataset.tab === 'pass')); });
  $('#intent-input').value = '经营改善、估值合理、走势相对稳定';
  $('#auth-email').value = '';
  $('#clarify-panel').hidden = true;
  $('#auth-screen').hidden = false;
  $('#app-shell').hidden = true;
  $('#auth-password').value = '';
  renderConditions();
}

function showApp(user) {
  state.user = user;
  $('#account-email').textContent = user.email;
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  loadMarket();
}

function authMode(mode) {
  document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.authMode === mode));
  $('#auth-title').textContent = mode === 'register' ? '创建研究账号' : '欢迎使用明筛';
  $('#auth-submit').innerHTML = mode === 'register' ? '注册并开始研究 <span>→</span>' : '登录并开始研究 <span>→</span>';
  $('#auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#password-hint').hidden = mode !== 'register';
  $('#auth-error').textContent = '';
}

document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => authMode(tab.dataset.authMode)));
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const mode = document.querySelector('.auth-tab.active').dataset.authMode;
  const button = $('#auth-submit'); button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const response = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#auth-email').value, password: $('#auth-password').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '账号操作失败');
    showApp(result.user);
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#logout-btn').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); }
  finally { showAuth(); }
});
$('#account-btn').addEventListener('click', () => { $('#account-error').textContent = ''; $('#delete-password').value = ''; $('#account-dialog').showModal(); });
$('#close-account').addEventListener('click', () => $('#account-dialog').close());
$('#account-dialog').addEventListener('click', event => { if (event.target === $('#account-dialog')) $('#account-dialog').close(); });
$('#delete-account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const response = await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#delete-password').value }) });
    const result = await response.json();
    if (!response.ok || !result.deleted) throw new Error(result.error || '删除失败');
    $('#account-dialog').close(); showAuth(); toast('账号和已保存策略已删除');
  } catch (error) { $('#account-error').textContent = error.message; }
  finally { button.disabled = false; }
});

function renderConditions() {
  const list = $('#condition-list');
  list.innerHTML = state.conditions.map((c, index) => `<div class="condition-card" data-index="${index}">
    <span class="condition-number">${String(index + 1).padStart(2, '0')}</span>
    <label class="sr-only" for="metric-${index}">指标</label><select id="metric-${index}" data-field="metric">${Object.entries(FIELDS).map(([key, field]) => `<option value="${key}" ${c.metric === key ? 'selected' : ''}>${field.name}</option>`).join('')}</select>
    <label class="sr-only" for="op-${index}">比较方式</label><select id="op-${index}" data-field="op">${Object.entries(OPERATORS).map(([key, label]) => `<option value="${key}" ${c.op === key ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label class="sr-only" for="value-${index}">阈值</label><input id="value-${index}" data-field="value" type="number" step="any" value="${Number.isFinite(c.value) ? c.value : ''}">
    ${c.op === 'between' ? `<label class="sr-only" for="max-${index}">上限</label><input id="max-${index}" data-field="max" type="number" step="any" value="${Number.isFinite(c.max) ? c.max : ''}">` : `<span class="condition-unit">${FIELDS[c.metric]?.unit || ''}</span>`}
    <button type="button" class="remove-condition" aria-label="删除第 ${index + 1} 条条件" data-remove="${index}">×</button>
  </div>`).join('');
  const assumptionBox = $('#assumptions');
  assumptionBox.hidden = state.assumptions.length === 0 && state.clarifications.length === 0;
  assumptionBox.innerHTML = [...state.assumptions.map(item => `工作假设：${esc(item)}`), ...state.clarifications.map(item => `待澄清：${esc(item)}`)].join('<br>');
  const unsupportedBox = $('#unsupported');
  unsupportedBox.hidden = state.unsupported.length === 0;
  unsupportedBox.innerHTML = `<strong>当前数据无法执行：</strong>${state.unsupported.map(esc).join('；')}。这些要求未被静默纳入筛选。`;
  const conflicts = findConflicts(state.conditions);
  const conflictBox = $('#conflicts');
  conflictBox.hidden = conflicts.length === 0;
  conflictBox.innerHTML = `<strong>条件冲突：</strong>${conflicts.map(esc).join('；')}。请修改阈值后再看结果。`;
  return conflicts;
}

function conditionText(c) {
  const field = FIELDS[c.metric];
  if (!field) return '未知条件';
  return c.op === 'between' ? `${field.name} ${num(c.value)}–${num(c.max)} ${field.unit}` : `${field.name} ${OPERATORS[c.op]} ${num(c.value)} ${field.unit}`;
}

function execute() {
  const conflicts = renderConditions();
  if (!state.market || conflicts.length || !state.conditions.length) {
    state.results = [];
    renderStats(null);
    renderResults();
    return;
  }
  state.results = state.market.stocks.map(stock => evaluateStock(stock, state.conditions));
  const currentPass = new Set(state.results.filter(item => item.status === 'pass').map(item => item.stock.code));
  let delta = null;
  if (state.previousPass) {
    const addedCodes = [...currentPass].filter(code => !state.previousPass.has(code));
    const removedCodes = [...state.previousPass].filter(code => !currentPass.has(code));
    delta = { added: addedCodes.length, removed: removedCodes.length, addedCodes, removedCodes };
  }
  state.previousPass = currentPass;
  renderStats(delta);
  renderResults();
}

function renderStats(delta) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  state.results.forEach(item => { counts[item.status]++; });
  for (const key of Object.keys(counts)) {
    $(`#count-${key}`).textContent = state.market && state.conditions.length && !findConflicts(state.conditions).length ? counts[key] : '—';
    $(`#tab-${key}`).textContent = counts[key];
  }
  $('#tab-compare').textContent = state.compare.size;
  $('#count-delta').textContent = delta ? `+${delta.added} / −${delta.removed}` : '—';
  $('#delta-caption').textContent = delta ? '新增入选 / 离开入选' : '相对上一次执行';
  const changeDetail = $('#change-detail');
  changeDetail.hidden = !delta || (!delta.added && !delta.removed);
  if (delta) {
    const name = code => state.market?.stocks.find(stock => stock.code === code)?.name || code;
    changeDetail.innerHTML = `<strong>本次条件变化：</strong>${delta.added ? `<span>新入选 ${delta.added} 只：${delta.addedCodes.slice(0, 6).map(code => esc(name(code))).join('、')}${delta.added > 6 ? '等' : ''}</span>` : ''}${delta.removed ? `<span>离开入选 ${delta.removed} 只：${delta.removedCodes.slice(0, 6).map(code => esc(name(code))).join('、')}${delta.removed > 6 ? '等' : ''}</span>` : ''}`;
  }
  $('#result-subtitle').textContent = !state.market ? '数据载入后，会按当前条件确定性计算。' : findConflicts(state.conditions).length ? '当前条件存在冲突，需先修改。' : `以上证50当前 ${state.market.universeCount} 只成分股为范围，按 ${state.conditions.length} 条条件计算。`;
}

function statusSummary(item) {
  if (item.status === 'pass') return '全部通过';
  const target = item.checks.find(check => check.status === (item.status === 'fail' ? 'fail' : 'unknown'));
  return `${item.status === 'fail' ? '未满足' : '缺失'}：${FIELDS[target?.condition?.metric]?.short || '条件'}`;
}

function stockRow(item) {
  const stock = item.stock;
  const cell = metric => {
    const value = stock.metrics?.[metric]?.value;
    return `<div class="metric-cell"><small>${FIELDS[metric].short}</small><strong class="${value === null ? 'missing' : ''}">${num(value)}${value === null ? '' : FIELDS[metric].unit}</strong></div>`;
  };
  return `<div class="stock-row"><input class="row-select" type="checkbox" aria-label="选择 ${esc(stock.name)} 进行比较" data-compare="${esc(stock.code)}" ${state.compare.has(stock.code) ? 'checked' : ''}>
    <button type="button" class="stock-main" data-stock="${esc(stock.code)}"><strong>${esc(stock.name)}</strong><small>${esc(stock.code)} · ${stock.latestPrice === null ? '价格缺失' : `最新价 ${num(stock.latestPrice, 2)} 元`}</small></button>
    ${cell('revenue_yoy')}${cell('profit_yoy')}${cell('pe_ttm')}${cell('volatility_20d')}
    <div class="row-status"><span class="pill ${item.status}">${esc(statusSummary(item))}</span></div></div>`;
}

function renderCompare() {
  const selected = state.results.filter(item => state.compare.has(item.stock.code)).slice(0, 3);
  if (!selected.length) return `<div class="empty-state"><strong>还没有比较对象</strong><p>在入选、排除或待核查列表勾选最多 3 只股票，即可并排比较关键数值和条件状态。</p></div>`;
  const rows = [
    ['筛选状态', item => item.status === 'pass' ? '入选' : item.status === 'fail' ? '排除' : '待核查'],
    ['营业收入同比', item => `${num(item.stock.metrics.revenue_yoy.value)}%`],
    ['归母净利润同比', item => `${num(item.stock.metrics.profit_yoy.value)}%`],
    ['PE TTM', item => `${num(item.stock.metrics.pe_ttm.value)} 倍`],
    ['PB MRQ', item => `${num(item.stock.metrics.pb_mrq.value)} 倍`],
    ['20 日年化波动率', item => `${num(item.stock.metrics.volatility_20d.value)}%`],
  ];
  return `<table class="compare-table"><thead><tr><th>指标</th>${selected.map(item => `<th><button type="button" class="stock-main" data-stock="${esc(item.stock.code)}"><strong>${esc(item.stock.name)}</strong><small>${esc(item.stock.code)}</small></button></th>`).join('')}</tr></thead><tbody>${rows.map(([label, getValue]) => `<tr><td>${label}</td>${selected.map(item => `<td class="${getValue(item).includes('—') ? 'missing' : ''}">${esc(getValue(item))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderResults() {
  const list = $('#result-list');
  if (!state.market) { list.innerHTML = `<div class="empty-state"><strong>正在等待真实数据</strong><p>页面会从扶摇接口获取上证50成分股、财务、估值与历史行情。</p></div>`; return; }
  if (findConflicts(state.conditions).length || !state.conditions.length) { list.innerHTML = `<div class="empty-state"><strong>尚不能执行筛选</strong><p>请解决冲突，或至少添加一条可执行条件。</p></div>`; return; }
  if (state.tab === 'compare') { list.innerHTML = renderCompare(); return; }
  const search = $('#stock-search').value.trim().toLowerCase();
  const matched = state.results.filter(item => item.status === state.tab && (!search || `${item.stock.name} ${item.stock.code}`.toLowerCase().includes(search)));
  list.innerHTML = matched.length ? matched.map(stockRow).join('') : `<div class="empty-state"><strong>${search ? '没有匹配的股票' : '这一类目前为空'}</strong><p>${search ? '试试其他名称或股票代码。' : '修改阈值后，结果会重新计算并显示影响。'}</p></div>`;
}

function rawText(raw) {
  if (!raw) return '无原始字段';
  if ('currentField' in raw) return `${raw.currentField}: ${num(raw.current, 2)} ${esc(raw.currency || 'CNY')}；同期 ${raw.priorField}: ${num(raw.prior, 2)} ${esc(raw.currency || 'CNY')}`;
  if ('field' in raw) return `${raw.field}: ${num(raw.value, 3)}`;
  return `close_price: ${raw.pricePoints || 0} 个交易日数据；${raw.adjust || ''} 复权`;
}

function openStock(code) {
  const item = state.results.find(row => row.stock.code === code);
  if (!item) return;
  const stock = item.stock;
  const pill = item.status === 'pass' ? '入选' : item.status === 'fail' ? '排除' : '待核查';
  const evidence = item.checks.map(({ condition, status }) => {
    const value = stock.metrics[condition.metric];
    return `<tr><td>${esc(conditionText(condition))}</td><td>${value?.value === null ? '<span class="missing">数据缺失</span>' : `${num(value?.value, 2)} ${esc(value?.unit)}`}</td><td><span class="pill ${status}">${status === 'pass' ? '通过' : status === 'fail' ? '未通过' : '缺失'}</span></td><td>${esc(value?.source?.reportEnd || value?.source?.asOf || '—')}</td></tr>`;
  }).join('');
  const sources = [...new Set(item.checks.map(({ condition }) => condition.metric))].map(key => {
    const value = stock.metrics[key]; const source = value?.source || {};
    return `<details class="source-card"><summary>${esc(FIELDS[key].name)} · 查看原始依据</summary><p>来源：${esc(source.provider || '—')} · <a href="${FIELDS[key].doc}" target="_blank" rel="noopener noreferrer">字段文档 ↗</a><br>接口：<code>${esc(source.endpoint || '—')}</code><br>报告期：${esc(source.reportEnd || '—')} · 接口报告日：${esc(source.published || '—')} · 比较期：${esc(source.priorReportEnd || '—')} · 数据日期：${esc(source.asOf || '—')}<br>原始字段：${rawText(value.raw)}<br>计算口径：${esc(source.method || '—')}<br>请求追踪 ID：${esc(source.requestId || '未提供')}</p></details>`;
  }).join('');
  $('#dialog-body').innerHTML = `<div class="section-index">EVIDENCE / ${esc(stock.code)}</div><div class="dialog-head"><div><h2 id="dialog-title">${esc(stock.name)}</h2><p>${esc(stock.code)} · 最新价 ${num(stock.latestPrice, 2)} 元 · 行情日期 ${esc(stock.priceAsOf || '—')}</p></div><span class="pill ${item.status}">${pill}</span></div><div class="dialog-summary">${item.status === 'pass' ? '当前所有条件均有数据且通过。' : item.status === 'fail' ? `至少一项未达到条件：${esc(item.checks.filter(row => row.status === 'fail').map(row => conditionText(row.condition)).join('；'))}` : '没有明确未通过的条件，但至少一项必要数据缺失。'}${stock.missing?.length ? `<br>接口情况：${stock.missing.map(esc).join('；')}` : ''}</div><table class="evidence-table"><thead><tr><th>当前条件</th><th>实际数据</th><th>结论</th><th>时点</th></tr></thead><tbody>${evidence}</tbody></table><div style="margin-top:22px" class="section-index">SOURCE TRACE / 原始依据</div>${sources}`;
  $('#stock-dialog').showModal();
}

async function loadMarket(refresh = false) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh-data').disabled = true;
  $('#data-status').className = 'data-status'; $('#data-status').textContent = refresh ? '正在重新获取真实数据…' : '正在连接扶摇金融数据…';
  $('#top-data-state').textContent = '正在取数';
  try {
    const response = await fetch(`/api/market${refresh ? '?refresh=1' : ''}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `接口返回 ${response.status}`);
    if (!Array.isArray(data.stocks) || data.stocks.length !== data.universeCount) throw new Error('返回的成分股数据不完整');
    state.market = data;
    state.previousPass = null;
    $('#universe-count').textContent = data.universeCount;
    $('#universe-asof').textContent = data.universeAsOf || '未提供';
    $('#fetched-at').textContent = asDateTime(data.fetchedAt);
    $('#data-status').className = 'data-status ok'; $('#data-status').textContent = `${data.stocks.length} 只成分股已载入 · ${['memory', 'database', 'shared'].includes(data.cache) ? '15 分钟共享缓存' : '本次实时获取'}`;
    $('#top-data-state').textContent = '真实数据已连接';
    $('#tool-footprint').innerHTML = `<strong>工具调用足迹</strong>${(data.toolFootprint || []).map(item => `<div><span>${({ snapshot: '行情快照', valuation: '估值快照', income: '批量利润表', history: '批量日线' })[item.type] || esc(item.type)}</span><span>${item.succeeded}/${item.requests} 成功</span></div>`).join('')}`;
    const issues = $('#api-issues'); issues.hidden = !data.issues.length;
    issues.innerHTML = data.issues.length ? `<strong>部分数据获取异常：</strong><br>${data.issues.map(item => `${esc(item.type)} 影响 ${item.affected} 只`).join('<br>')}` : '';
    execute();
  } catch (error) {
    if (/请先注册或登录/.test(error.message)) return showAuth();
    $('#data-status').className = 'data-status error'; $('#data-status').textContent = error.message || '取数失败';
    $('#top-data-state').textContent = '数据连接异常';
    toast('数据连接失败，请检查接口状态后重试');
    if (!state.market) renderResults();
  } finally { state.loading = false; $('#refresh-data').disabled = false; }
}

function renderClarify() {
  $('#clarify-panel').hidden = false;
  $('#clarify-questions').innerHTML = state.clarifications.length ? `<strong>AI 待确认：</strong>${state.clarifications.map(esc).join('；')}` : '还想补充吗？你可以说明行业偏好、指标阈值，或修正刚才的表达。';
  $('#clarify-history').textContent = state.followUps.length ? `已补充：${state.followUps.join(' → ')}` : '';
}

async function interpret(followUp = false) {
  const text = followUp ? state.intentBase : $('#intent-input').value.trim();
  if (!text) { toast('请先输入选股意图'); return; }
  const reply = followUp ? $('#clarify-input').value.trim() : '';
  if (followUp && !reply) return toast('请先输入补充说明');
  if (followUp && state.followUps.length >= 3) return toast('最多补充三轮，请直接修改原始意图后重新解析');
  const followUps = followUp ? [...state.followUps, reply] : [];
  const button = followUp ? $('#clarify-submit') : $('#interpret-btn'); button.disabled = true; $('#interpret-status').textContent = 'DeepSeek 正在理解意图并生成可检查条件…';
  try {
    const response = await fetch('/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, followUps }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '解析失败');
    state.intentBase = text;
    state.followUps = followUps;
    state.unsupported = result.unsupported || [];
    state.clarifications = result.clarifications || [];
    state.assumptions = result.assumptions || [];
    renderClarify();
    $('#clarify-input').value = '';
    if (!result.conditions.length) {
      state.conditions = [];
      execute();
      $('#interpret-status').textContent = '没有识别出可由当前 5 个指标执行的条件。请修改描述或手动添加条件。';
      return;
    }
    state.conditions = result.conditions;
    $('#interpret-status').textContent = `DeepSeek 已理解 ${followUps.length ? '补充后的' : ''}意图，生成 ${result.conditions.length} 条条件草案。请核对阈值。`;
    execute();
    if (!followUp) $('#conditions').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if (/请先注册或登录/.test(error.message)) return showAuth(); $('#interpret-status').textContent = error.message; toast('AI 暂不可用，可手动修改当前条件'); }
  finally { button.disabled = false; }
}

$('#interpret-btn').addEventListener('click', () => interpret(false));
$('#clarify-submit').addEventListener('click', () => interpret(true));
$('#clarify-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); interpret(true); } });
document.querySelectorAll('.example').forEach(button => button.addEventListener('click', () => { $('#intent-input').value = button.dataset.prompt; $('#intent-input').focus(); }));
$('#condition-list').addEventListener('change', event => {
  const card = event.target.closest('.condition-card'); if (!card) return;
  const index = Number(card.dataset.index); const field = event.target.dataset.field;
  if (!field) return;
  state.conditions[index][field] = field === 'value' || field === 'max' ? (event.target.value.trim() === '' ? NaN : Number(event.target.value)) : event.target.value;
  if (field === 'op' && event.target.value === 'between' && !Number.isFinite(state.conditions[index].max)) state.conditions[index].max = 30;
  state.conditions[index].label = '用户已修改';
  execute();
});
$('#condition-list').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove]'); if (!remove) return;
  state.conditions.splice(Number(remove.dataset.remove), 1); execute();
});
$('#add-condition').addEventListener('click', () => { if (state.conditions.length >= 8) return toast('最多支持 8 条条件'); state.conditions.push({ metric: 'revenue_yoy', op: 'gte', value: 0, label: '用户添加' }); execute(); });
$('#reset-conditions').addEventListener('click', () => { state.conditions = structuredClone(DEFAULTS); state.assumptions = ['示例阈值均可修改；PE TTM 范围与年化波动率不是统一投资标准。']; state.unsupported = []; state.clarifications = []; execute(); toast('已恢复示例条件'); });
$('#refresh-data').addEventListener('click', () => loadMarket(true));
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.tab; document.querySelectorAll('.tab').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); }); renderResults(); }));
$('#stock-search').addEventListener('input', renderResults);
$('#result-list').addEventListener('click', event => { const button = event.target.closest('[data-stock]'); if (button) openStock(button.dataset.stock); });
$('#result-list').addEventListener('change', event => {
  const box = event.target.closest('[data-compare]'); if (!box) return;
  if (box.checked && state.compare.size >= 3) { box.checked = false; toast('最多比较 3 只股票'); return; }
  if (box.checked) state.compare.add(box.dataset.compare); else state.compare.delete(box.dataset.compare);
  $('#tab-compare').textContent = state.compare.size;
  if (state.tab === 'compare') renderResults();
});
$('#close-dialog').addEventListener('click', () => $('#stock-dialog').close());
$('#stock-dialog').addEventListener('click', event => { if (event.target === $('#stock-dialog')) $('#stock-dialog').close(); });
$('#save-strategy').addEventListener('click', async () => {
  if (!state.conditions.length || findConflicts(state.conditions).length) return toast('请先保留至少一条无冲突条件');
  try {
    const text = $('#intent-input').value.trim();
    const response = await fetch('/api/strategies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: text.slice(0, 60) || '手动筛选策略', text, conditions: state.conditions, assumptions: state.assumptions }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    toast('策略已保存到账号，可在其他设备登录后读取');
  } catch (error) { toast(error.message); }
});

async function listStrategies() {
  const response = await fetch('/api/strategies');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '读取失败');
  state.strategies = data.strategies;
  $('#strategy-list').innerHTML = state.strategies.length ? state.strategies.map(item => `<div class="strategy-item"><div><strong>${esc(item.title)}</strong><small>${item.conditions.length} 条条件 · ${asDateTime(item.updatedAt)}</small></div><div class="strategy-item-actions"><button type="button" data-load="${esc(item.id)}">载入</button><button type="button" data-delete="${esc(item.id)}">删除</button></div></div>`).join('') : '<div class="empty-state"><strong>还没有已保存策略</strong><p>调整并执行条件后，点击“保存本次条件”。</p></div>';
}
$('#load-strategy').addEventListener('click', async () => {
  try { await listStrategies(); $('#strategies-dialog').showModal(); }
  catch (error) { toast(error.message); }
});
$('#close-strategies').addEventListener('click', () => $('#strategies-dialog').close());
$('#strategies-dialog').addEventListener('click', event => { if (event.target === $('#strategies-dialog')) $('#strategies-dialog').close(); });
$('#strategy-list').addEventListener('click', async event => {
  const loadButton = event.target.closest('[data-load]');
  if (loadButton) {
    const saved = state.strategies.find(item => item.id === loadButton.dataset.load);
    if (!saved) return;
    state.conditions = saved.conditions.filter(c => FIELDS[c.metric] && OPERATORS[c.op]).slice(0, 8);
    state.assumptions = saved.assumptions || [];
    state.unsupported = []; state.clarifications = [];
    $('#intent-input').value = saved.text || '';
    $('#strategies-dialog').close(); execute();
    toast('已按当前市场数据重新执行保存的条件');
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    try {
      const response = await fetch(`/api/strategies/${deleteButton.dataset.delete}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.deleted) throw new Error(result.error || '删除失败');
      await listStrategies(); toast('已删除策略');
    } catch (error) { toast(error.message); }
  }
});

renderConditions(); renderResults();
fetch('/api/session').then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); if (result.user) showApp(result.user); else showAuth(); }).catch(error => { showAuth(); $('#auth-error').textContent = error.message || '账号服务暂不可用'; });
