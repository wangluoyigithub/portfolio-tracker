let state = { transactions: [], prices: [], positions: [], settings: {}, fund_rules: [], fund_rule_templates: [], sale_allocations: [], archives: [], accounts: [] };
let activeView = 'dashboard';
let dashboardAccount = '__all__';
let simTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const num = (value) => Number(value || 0);
const decimal = (value, digits) => { const number = num(value); if (!Number.isFinite(number)) return ''; if (Math.abs(number) < 1e-12) return '0'; return number.toFixed(digits).replace(/\.?0+$/, ''); };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const money = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const quantity = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const unitPrice = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const percent = (value) => `${(num(value) * 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
const tone = (value) => num(value) >= 0 ? 'positive' : 'negative';
const positionId = (position) => `${position.account}\u001f${position.code}`;
const findPosition = (id) => state.positions.find(position => positionId(position) === id);
const findRule = (account, code) => state.fund_rules.find(rule => rule.account === account && rule.code === code);

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { window.location.href = '/'; throw new Error('登录已过期，请重新登录'); }
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2400);
}

async function refresh() {
  state = await api('/api/state');
  render();
}

function positionTotals(rows) {
  const sum = key => rows.reduce((total, row) => total + num(row[key]), 0);
  const market = sum('market_value');
  const cost = sum('book_cost');
  const total = sum('total_pnl');
  const invested = sum('net_cash_invested');
  return { market, cost, total, rate: invested ? total / Math.abs(invested) : 0, invested };
}

function kpi(label, value, css = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${css}">${value}</div></div>`;
}

function positionActions(position) {
  const fundRule = position.asset_type === '基金' ? `<button class="ghost small-btn" data-position-rule="${esc(positionId(position))}">基金费率</button>` : '';
  const positionAction = Math.abs(num(position.quantity)) <= 1e-8
    ? `<button class="ghost small-btn" data-archive-position="${esc(positionId(position))}">归档</button>`
    : `<button class="ghost small-btn" data-edit-position="${esc(positionId(position))}">修改持仓</button>`;
  return `<div class="row-actions">${fundRule}${positionAction}</div>`;
}

function positionTable(rows) {
  if (!rows.length) return '<div class="empty">暂无持仓。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>代码</th><th>名称</th><th>现价</th><th>类型</th><th>成本价</th><th>持仓</th><th>市值</th><th>总盈亏</th><th>收益率</th><th></th></tr></thead><tbody>${rows.map(position => `<tr>
    <td class="code">${esc(position.code)}</td>
    <td><button class="link-btn" data-trade-position="${esc(positionId(position))}">${esc(position.name)}</button></td>
    <td><input class="price-input" type="number" step="0.0001" data-code="${esc(position.code)}" data-name="${esc(position.name)}" data-type="${esc(position.asset_type)}" value="${decimal(position.current_price, 4)}"></td><td>${esc(position.asset_type)}</td>
    <td>${unitPrice(position.avg_cost)}</td>
    <td>${quantity(position.quantity)}</td><td>${money(position.market_value)}</td>
    <td class="${tone(position.total_pnl)}">${money(position.total_pnl)}</td><td class="${tone(position.return_rate)}">${percent(position.return_rate)}</td><td>${positionActions(position)}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function accountPanel(account) {
  const rows = state.positions.filter(position => position.account === account);
  const total = positionTotals(rows);
  return `<div class="panel account-panel"><div class="panel-title"><div><h3>${esc(account)}</h3><span class="hint">${rows.length} 个持仓</span></div><div class="account-figures"><span>市值 ¥${money(total.market)}</span><span class="${tone(total.total)}">盈亏 ¥${money(total.total)}</span><span class="${tone(total.rate)}">${percent(total.rate)}</span></div></div>${positionTable(rows)}</div>`;
}

function renderDashboard() {
  const accounts = state.accounts.length ? state.accounts : ['默认账户'];
  if (dashboardAccount !== '__all__' && !accounts.includes(dashboardAccount)) dashboardAccount = '__all__';
  const selectedRows = dashboardAccount === '__all__' ? state.positions : state.positions.filter(position => position.account === dashboardAccount);
  const total = positionTotals(selectedRows);
  const scope = dashboardAccount === '__all__' ? '全部账户' : dashboardAccount;
  const accountButtons = [`<button type="button" class="account-filter ${dashboardAccount === '__all__' ? 'active' : ''}" data-dashboard-account="__all__">全部账户</button>`, ...accounts.map(account => `<button type="button" class="account-filter ${dashboardAccount === account ? 'active' : ''}" data-dashboard-account="${esc(account)}">${esc(account)}</button>`)].join('');
  const panels = dashboardAccount === '__all__' ? accounts.map(accountPanel).join('') : accountPanel(dashboardAccount);
  const clearedCount = selectedRows.filter(position => Math.abs(num(position.quantity)) <= 1e-8).length;
  $('#dashboard').innerHTML = `<div class="section-head"><div><h2>账户总览</h2><p>切换账户查看独立成本、盈亏与收益率。点击持仓名称进行实际加仓或减仓。</p></div><div class="section-actions"><button class="ghost danger" id="bulkDeletePositions" type="button">批量删除</button><button class="ghost" id="refreshAllPrices" type="button">刷新行情</button><button class="primary" id="addPosition">添加持仓</button></div></div>
    <div class="account-filter-bar" role="tablist" aria-label="选择账户">${accountButtons}</div>
    ${clearedCount ? `<div class="notice archive-reminder"><span>有 ${clearedCount} 个持仓数量已经为 0，可归档保存完整流水、盈亏和交易心得。</span><button class="primary small-btn" id="archiveAllCleared" type="button">一键归档</button></div>` : ''}
    <div class="kpi-grid">${kpi('市值', `¥${money(total.market)}`)}${kpi('成本', `¥${money(total.cost)}`)}${kpi('盈亏', `¥${money(total.total)}`, tone(total.total))}${kpi('收益率', percent(total.rate), tone(total.rate))}</div>
    ${panels}`;
  $('#addPosition').addEventListener('click', () => openPositionModal());
  $('#bulkDeletePositions').addEventListener('click', openBulkDeletePositions);
  $('#refreshAllPrices').addEventListener('click', refreshAllPrices);
  $('#archiveAllCleared')?.addEventListener('click', archiveAllCleared);
  $$('[data-dashboard-account]').forEach(button => button.addEventListener('click', () => { dashboardAccount = button.dataset.dashboardAccount; renderDashboard(); }));
  bindPriceInputs();
}

function bindPriceInputs() {
  $$('.price-input').forEach(input => input.addEventListener('change', async () => {
    try {
      await api('/api/prices', { method: 'POST', body: JSON.stringify({ code: input.dataset.code, name: input.dataset.name, asset_type: input.dataset.type, price: num(input.value) }) });
      toast('当前价格已更新');
      await refresh();
    } catch (error) { toast(error.message); }
  }));
}

async function refreshAllPrices() {
  const button = $('#refreshAllPrices');
  if (!button || button.disabled) return;
  const codes = [...new Map(state.positions.map(position => [position.code, position])).values()];
  if (!codes.length) return toast('暂无持仓可刷新');
  button.disabled = true;
  let success = 0, failed = 0;
  try {
    for (const position of codes) {
      try {
        const result = await api(`/api/lookup?code=${encodeURIComponent(position.code)}`);
        const item = result.candidates?.find(candidate => num(candidate.price) > 0) || result.candidates?.[0];
        if (!item || !num(item.price)) throw new Error('暂无价格');
        await api('/api/prices', { method: 'POST', body: JSON.stringify({ code: item.code || position.code, name: item.name || position.name, asset_type: item.asset_type || position.asset_type, price: num(item.price) }) });
        success += 1;
      } catch (_) { failed += 1; }
    }
    toast(`已刷新 ${success} 个品种${failed ? `，${failed} 个未查到` : ''}`);
    await refresh();
  } finally { button.disabled = false; }
}

function accountSelect(name, selected = '') {
  const options = state.accounts.map(account => `<option value="${esc(account)}" ${account === selected ? 'selected' : ''}>${esc(account)}</option>`).join('');
  return `<select class="input" name="${name}">${options}<option value="__new__" ${!state.accounts.length ? 'selected' : ''}>＋ 新增账户</option></select>`;
}

function rateSelect(selected = 0) {
  const custom = ![0, 0.0015].some(value => Math.abs(value - num(selected)) < 1e-10);
  return `<select class="input buy-rate-select"><option value="0" ${!custom && num(selected) === 0 ? 'selected' : ''}>0%</option><option value="0.0015" ${!custom && num(selected) === 0.0015 ? 'selected' : ''}>0.15%</option><option value="custom" ${custom ? 'selected' : ''}>自定义费率</option></select>`;
}

const commonRanges = [[0, 7], [7, 30], [30, 90], [90, 180], [180, 360], [360, null]];
function rangeLabel(start, end) { return end == null ? `${start}天 ≤ 持有天数` : `${start}天 ≤ 持有天数＜${end}天`; }
function tierRow(tier = { min_days: 0, max_days: 7, rate: 0.015 }) {
  const start = num(tier.min_days), end = tier.max_days == null ? null : num(tier.max_days);
  const matched = commonRanges.some(([a, b]) => a === start && b === end);
  const preview = end == null ? `${start}天 ≤ 持有天数` : `${start}天 ≤ 持有天数＜${end}天`;
  return `<div class="tier-row"><select class="input tier-range">${commonRanges.map(([a, b]) => `<option value="${a},${b == null ? '' : b}" ${a === start && b === end ? 'selected' : ''}>${rangeLabel(a, b)}</option>`).join('')}<option value="custom" ${matched ? 'hidden' : 'selected'}>${matched ? '自定义区间' : preview}</option><option value="custom_edit">${matched ? '自定义区间…' : '重新自定义区间…'}</option></select><input class="tier-start" type="hidden" value="${start}"><input class="tier-end" type="hidden" value="${end ?? ''}"><div class="tier-rate-wrap"><input class="input tier-rate" type="number" min="0" step="0.01" value="${decimal(num(tier.rate) * 100, 2)}"><span>%</span></div><button type="button" class="danger-btn remove-tier">删除</button></div>`;
}

function nextTier(container) {
  const rows = [...container.querySelectorAll('.tier-row')];
  if (!rows.length) return { min_days: 0, max_days: 7, rate: 0.015 };
  const last = rows[rows.length - 1];
  const value = last.querySelector('.tier-range').value;
  let end = value === 'custom' ? (last.querySelector('.tier-end').value === '' ? null : num(last.querySelector('.tier-end').value)) : value.split(',')[1] === '' ? null : num(value.split(',')[1]);
  if (end == null) return { min_days: 360, max_days: null, rate: 0 };
  const candidate = commonRanges.find(([start]) => start === end);
  return candidate ? { min_days: candidate[0], max_days: candidate[1], rate: 0 } : { min_days: end, max_days: null, rate: 0 };
}

function appendTier(container) {
  const rows = [...container.querySelectorAll('.tier-row')];
  if (rows.length) {
    const last = rows[rows.length - 1];
    const value = last.querySelector('.tier-range').value;
    const start = value === 'custom' ? num(last.querySelector('.tier-start').value) : num(value.split(',')[0]);
    const end = value === 'custom' ? (last.querySelector('.tier-end').value === '' ? null : num(last.querySelector('.tier-end').value)) : value.split(',')[1] === '' ? null : num(value.split(',')[1]);
    if (end == null) {
      const next = commonRanges.find(([a, b]) => a === start && b != null);
      if (!next) { toast('最后一档已是无上限，无法继续增加'); return; }
      last.querySelector('.tier-range').value = `${next[0]},${next[1]}`;
      last.querySelector('.tier-start').value = next[0];
      last.querySelector('.tier-end').value = next[1];
      last.querySelector('.tier-range option[value="custom"]').hidden = true;
      container.insertAdjacentHTML('beforeend', tierRow({ min_days: next[1], max_days: null, rate: 0 }));
      bindTierEditor(container);
      return;
    }
  }
  container.insertAdjacentHTML('beforeend', tierRow(nextTier(container)));
  bindTierEditor(container);
}

function setTierEditor(container, tiers) {
  container.innerHTML = (tiers?.length ? tiers : [{ min_days: 0, max_days: 7, rate: 0.015 }]).map(tierRow).join('');
  bindTierEditor(container);
}

function bindTierEditor(container) {
  container.querySelectorAll('.tier-range').forEach(select => {
    if (select.dataset.bound) return;
    select.dataset.bound = '1';
    select.dataset.previousValue = select.value;
    select.addEventListener('change', () => {
      const row = select.closest('.tier-row');
      if (select.value === 'custom_edit') {
        openTierRangeDialog(row, select);
      } else if (select.value !== 'custom') {
        const [start, end] = select.value.split(',');
        row.querySelector('.tier-start').value = start;
        row.querySelector('.tier-end').value = end;
        select.dataset.previousValue = select.value;
      } else {
        select.dataset.previousValue = 'custom';
      }
    });
  });
  container.querySelectorAll('.remove-tier').forEach(button => {
    if (button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => button.closest('.tier-row')?.remove());
  });
}

function openTierRangeDialog(row, select) {
  $('#tierRangeDialog')?.remove();
  const previous = select.dataset.previousValue || '0,7';
  const start = row.querySelector('.tier-start').value || '0';
  const end = row.querySelector('.tier-end').value;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop tier-range-backdrop" id="tierRangeDialog"><div class="modal range-modal"><div class="panel-title"><h3>自定义持有天数</h3><button class="ghost range-cancel" type="button">取消</button></div><form id="tierRangeForm" class="form-grid"><div class="field"><label>起始天数</label><input class="input range-start" type="number" min="0" value="${esc(start)}" required></div><div class="field"><label>结束天数</label><input class="input range-end" type="number" min="0" value="${esc(end)}" placeholder="留空表示无上限"></div><div class="range-confirm-text"></div><div class="form-actions"><button class="primary" type="submit">确认</button></div></form></div></div>`);
  const dialog = $('#tierRangeDialog');
  const startInput = dialog.querySelector('.range-start');
  const endInput = dialog.querySelector('.range-end');
  const summary = dialog.querySelector('.range-confirm-text');
  const updateSummary = () => { const a = num(startInput.value); const b = endInput.value === '' ? null : num(endInput.value); summary.textContent = rangeLabel(a, b); };
  const cancel = () => { select.value = previous; dialog.remove(); };
  startInput.addEventListener('input', updateSummary);
  endInput.addEventListener('input', updateSummary);
  dialog.querySelector('.range-cancel').addEventListener('click', cancel);
  dialog.querySelector('#tierRangeForm').addEventListener('submit', event => {
    event.preventDefault();
    const a = num(startInput.value);
    const b = endInput.value === '' ? null : num(endInput.value);
    if (a < 0 || (b != null && b <= a)) { summary.textContent = '结束天数必须大于起始天数'; summary.classList.add('negative'); return; }
    row.querySelector('.tier-start').value = a;
    row.querySelector('.tier-end').value = b == null ? '' : b;
    const customOption = select.querySelector('option[value="custom"]');
    customOption.hidden = false;
    customOption.textContent = rangeLabel(a, b);
    select.querySelector('option[value="custom_edit"]').textContent = '重新自定义区间…';
    select.value = 'custom';
    select.dataset.previousValue = 'custom';
    dialog.remove();
  });
  updateSummary();
  startInput.focus();
}

function collectTiers(container) {
  return [...container.querySelectorAll('.tier-row')].map(row => {
    const range = row.querySelector('.tier-range').value;
    let start, end;
    if (range === 'custom') {
      start = num(row.querySelector('.tier-start').value);
      end = row.querySelector('.tier-end').value === '' ? null : num(row.querySelector('.tier-end').value);
    } else {
      const parts = range.split(','); start = num(parts[0]); end = parts[1] === '' ? null : num(parts[1]);
    }
    return { min_days: start, max_days: end, rate: num(row.querySelector('.tier-rate').value) / 100 };
  }).sort((a, b) => a.min_days - b.min_days);
}

function ruleSourceOptions(selected = '') {
  const templates = state.fund_rule_templates.map(item => { const value = `template:${item.id}`; return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>模板：${esc(item.name)}</option>`; }).join('');
  return `${templates}<option value="custom" ${selected === 'custom' ? 'selected' : ''}>自定义</option>`;
}

function commonRuleTemplate() {
  return state.fund_rule_templates.find(item => item.id === 'common' || item.name === '常用赎回规则') || state.fund_rule_templates[0];
}

function calculatorFields(prefix, labels = {}) {
  return `<div class="field"><label>${labels.price || '净值/成交价'}</label><input class="input calc-price" id="${prefix}Price" type="number" min="0" step="0.000001"></div><div class="field"><label>${labels.quantity || '数量/份额'}</label><input class="input calc-quantity" id="${prefix}Quantity" type="number" min="0" step="0.0001"></div><div class="field"><label>${labels.amount || '金额'}</label><input class="input calc-amount" id="${prefix}Amount" type="number" min="0" step="0.01"></div>`;
}

function bindCalculator(root, onChange, options = {}) {
  const amount = root.querySelector('.calc-amount'), qty = root.querySelector('.calc-quantity'), price = root.querySelector('.calc-price');
  const sync = source => {
    const a = num(amount.value), q = num(qty.value), p = num(price.value);
    const factor = Math.max(num(options.grossFactor?.()) || 1, 1e-12);
    if (source === amount && a > 0) { if (p > 0) qty.value = decimal(a / factor / p, 4); else if (q > 0) price.value = decimal(a / factor / q, 4); }
    if (source === qty && q > 0) { if (p > 0) amount.value = decimal(q * p * factor, 3); else if (a > 0) price.value = decimal(a / factor / q, 4); }
    if (source === price && p > 0) { if (q > 0) amount.value = decimal(q * p * factor, 3); else if (a > 0) qty.value = decimal(a / factor / p, 4); }
    onChange?.();
  };
  [amount, qty, price].forEach(input => input.addEventListener('input', () => sync(input)));
  return { amount, qty, price, recalculate: source => sync(source === 'quantity' ? qty : source === 'price' ? price : amount) };
}

function recalculateAmount(calculator) {
  if (num(calculator.amount.value) > 0) calculator.recalculate('amount');
  else if (num(calculator.qty.value) > 0 && num(calculator.price.value) > 0) calculator.recalculate('quantity');
}

async function lookupAsset(code) {
  const result = await api(`/api/lookup?code=${encodeURIComponent(code)}`);
  if (!result.candidates?.length) throw new Error('没有找到匹配品种，可手工填写');
  let selected = result.candidates[0];
  if (result.candidates.length > 1) {
    const text = result.candidates.map((item, index) => `${index + 1}. ${item.name}（${item.asset_type}）`).join('\n');
    const index = Number(prompt(`找到多个品种，请输入序号：\n${text}`, '1')) - 1;
    if (result.candidates[index]) selected = result.candidates[index];
  }
  return selected;
}

function modal(title, body) {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="activeModal"><div class="modal"><div class="panel-title"><h3>${title}</h3><button class="ghost modal-close" type="button">关闭</button></div>${body}</div></div>`);
  $('.modal-close').addEventListener('click', closeModal);
  return $('#activeModal .modal');
}
function closeModal() { $('#activeModal')?.remove(); }
function selectedAccount(form) { return form.account_select.value === '__new__' ? form.new_account.value.trim() : form.account_select.value; }

function currentPriceField() {
  return `<div class="field current-price-field"><label>现价</label><input class="input snapshot-current" name="current_price" type="number" min="0" step="0.0001"></div>`;
}

function snapshotFields({ includeCurrent = true } = {}) {
  return `<div class="snapshot-fields form-grid" style="grid-column:1/-1"><div class="field"><label>市值</label><input class="input snapshot-market" name="market_value" type="number" min="0" step="0.001"></div><div class="field"><label>成本价</label><input class="input snapshot-cost" name="book_cost" type="number" min="0" step="0.0001"></div><div class="field"><label>持仓数量</label><input class="input snapshot-quantity" name="holding_quantity" type="number" min="0" step="0.0001"></div>${includeCurrent ? currentPriceField() : ''}<div class="field"><label>盈亏</label><input class="input snapshot-pnl" name="pnl" type="number" readonly step="0.001"></div></div>`;
}

function openPositionModal() {
  const defaultRuleSource = `template:${commonRuleTemplate()?.id || ''}`;
  const body = `<p class="hint">手工录入会生成一笔初始买入交易；基金也可以直接导入 PDF 交易流水。</p><form id="positionForm" class="form-grid">
    <div class="field"><label>账户</label>${accountSelect('account_select')}</div><div class="field new-account-field"><label>新账户名称</label><input class="input" name="new_account" placeholder="输入一次，以后可下拉选择"></div>
    <div class="field"><label>类型</label><select class="input" name="asset_type"><option>股票</option><option>ETF</option><option>可转债</option><option>基金</option></select></div>
    <div class="fund-entry-field field" style="display:none"><label>基金持仓来源</label><select class="input" name="entry_mode"><option value="manual">手工填写当前持仓</option><option value="pdf">导入 PDF 交易流水</option></select></div>
    <div class="code-field field"><label>代码</label><div class="inline-field"><input class="input" name="code"><button class="ghost" id="positionLookup" type="button">查询</button></div></div>
    <div class="name-field field"><label>名称</label><input class="input" name="name"></div>${currentPriceField()}<div class="date-field field"><label>确认日期</label><input class="input" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
    ${snapshotFields({ includeCurrent: false })}
    <div class="pdf-fields subpanel" style="display:none;grid-column:1/-1"><div class="panel-title"><h3>导入基金交易流水</h3></div><p class="hint">选择 PDF 后先解析预览，确认提交后才会写入交易流水。</p><input class="input pdf-file" type="file" accept="application/pdf,.pdf"><div class="pdf-preview empty">尚未选择 PDF。</div></div>
    <div class="fund-fields subpanel" style="grid-column:1/-1"><div class="panel-title"><h3>基金费率</h3></div><div class="form-grid"><div class="field"><label>买入费率</label>${rateSelect(0)}</div><div class="field custom-rate-field" style="display:none"><label>自定义买入费率（%）</label><input class="input custom-rate" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>赎回规则</label><select class="input rule-source">${ruleSourceOptions(defaultRuleSource)}</select></div></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button><button class="ghost save-template" type="button">另存为模板</button></div></div>
    <div class="form-actions" style="grid-column:1/-1"><button class="primary" type="submit">保存持仓</button></div></form>`;
  const root = modal('添加持仓', body), form = $('#positionForm');
  let pdfPreview = null;
  const updateSnapshot = () => { const market = num(form.market_value.value), cost = num(form.book_cost.value), qty = num(form.holding_quantity.value), current = num(form.current_price.value); if (current > 0 && qty > 0) form.market_value.value = decimal(current * qty, 3); const effectiveCurrent = current || (market && qty ? market / qty : 0); form.pnl.value = effectiveCurrent && qty ? decimal((effectiveCurrent - cost) * qty, 3) : ''; };
  const updateAccount = () => { root.querySelector('.new-account-field').style.display = form.account_select.value === '__new__' ? 'flex' : 'none'; };
  const updateType = () => { const fund = form.asset_type.value === '基金'; const pdf = fund && form.entry_mode.value === 'pdf'; root.querySelector('.fund-entry-field').style.display = fund ? 'flex' : 'none'; root.querySelector('.fund-fields').style.display = fund && !pdf ? 'block' : 'none'; root.querySelector('.snapshot-fields').style.display = pdf ? 'none' : 'grid'; root.querySelector('.current-price-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('.pdf-fields').style.display = pdf ? 'block' : 'none'; root.querySelector('.code-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('.name-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('.date-field').style.display = fund && !pdf ? 'flex' : 'none'; form.date.required = fund && !pdf; root.querySelector('button[type="submit"]').textContent = pdf ? '下一步：选择基金' : '保存持仓'; };
  form.account_select.addEventListener('change', updateAccount); form.asset_type.addEventListener('change', updateType); form.entry_mode.addEventListener('change', updateType);
  ['market_value', 'book_cost', 'holding_quantity', 'current_price'].forEach(name => form[name].addEventListener('input', updateSnapshot));
  root.querySelector('.buy-rate-select').addEventListener('change', event => { root.querySelector('.custom-rate-field').style.display = event.target.value === 'custom' ? 'flex' : 'none'; });
  root.querySelector('.rule-source').addEventListener('change', event => applyRuleSource(event.target.value, root));
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  root.querySelector('.save-template').addEventListener('click', () => saveTemplateFrom(root));
  root.querySelector('.pdf-file').addEventListener('change', event => { const file = event.target.files[0]; if (!file) return; const preview = root.querySelector('.pdf-preview'); preview.textContent = '正在解析…'; const reader = new FileReader(); reader.onload = async () => { try { const result = await api('/api/import-pdf-preview', { method: 'POST', body: JSON.stringify({ filename: file.name, data: String(reader.result).split(',')[1] }) }); pdfPreview = result; preview.innerHTML = `<strong>${esc(file.name)}</strong><br>共 ${result.pages} 页，识别买入 ${result.buy_count} 笔、卖出 ${result.sell_count} 笔，其中跨 TA 转换 ${result.conversion_count} 笔。${result.warnings?.length ? `<p class="negative">需核对：${esc(result.warnings.slice(0, 3).join('；'))}${result.warnings.length > 3 ? '…' : ''}</p>` : '<p class="positive">未发现解析异常。</p>'}`; } catch (error) { pdfPreview = null; preview.textContent = error.message; } }; reader.readAsDataURL(file); });
  root.querySelector('#positionLookup').addEventListener('click', async () => { try { const item = await lookupAsset(form.code.value.trim()); form.code.value = item.code; form.name.value = item.name; form.asset_type.value = item.asset_type; if (num(item.price) > 0) form.current_price.value = decimal(item.price, 4); updateType(); updateSnapshot(); toast(`已识别：${item.name}${num(item.price) > 0 ? `，现价 ${unitPrice(item.price)}` : ''}`); } catch (error) { toast(error.message); } });
  form.addEventListener('submit', event => saveNewPosition(event, root, pdfPreview));
  setTierEditor(root.querySelector('.tier-editor'), commonRuleTemplate()?.redemption_tiers || []);
  updateAccount(); updateType(); updateSnapshot();
}

function applyRuleSource(value, root) {
  if (!value) return;
  if (value === 'custom') { setTierEditor(root.querySelector('.tier-editor'), []); return; }
  let source;
  if (value.startsWith('template:')) source = state.fund_rule_templates.find(item => item.id === value.slice(9));
  if (value.startsWith('rule:')) { const [account, code] = value.slice(5).split('\u001f'); source = findRule(account, code); }
  if (source) setTierEditor(root.querySelector('.tier-editor'), source.redemption_tiers);
}

function selectedBuyRate(root) {
  const value = root.querySelector('.buy-rate-select')?.value;
  return value === 'custom' ? num(root.querySelector('.custom-rate')?.value) / 100 : num(value);
}

async function updatePositionFee(form, calculator) {
  if (!calculator) return;
  const qty = num(calculator.qty.value), price = num(calculator.price.value);
  if (!qty || !price) { form.querySelector('.fee-display').value = '0'; return; }
  if (form.asset_type.value === '基金') {
    const amount = qty * price, rate = selectedBuyRate(form);
    form.querySelector('.fee-display').value = decimal(amount * rate, 2);
    return;
  }
  try {
    const result = await feePreview({ account: selectedAccount(form), code: form.code.value, asset_type: form.asset_type.value, operation: '加仓', quantity: qty, price });
    form.querySelector('.fee-display').value = decimal(result.buy_fee, 2);
  } catch (_) { form.querySelector('.fee-display').value = '—'; }
}

async function saveTemplateFrom(root) {
  const name = prompt('模板名称');
  if (!name) return;
  try { await api('/api/fund-rule-templates', { method: 'POST', body: JSON.stringify({ name, redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) }); toast('规则模板已保存'); await refresh(); } catch (error) { toast(error.message); }
}

async function saveNewPosition(event, root, pdfPreview) {
  event.preventDefault();
  const form = event.currentTarget, account = selectedAccount(form), code = form.code.value.trim(), assetType = form.asset_type.value, pdfMode = assetType === '基金' && form.entry_mode.value === 'pdf';
  if (!account) return toast('请选择或填写账户');
  if (pdfMode) {
    if (!pdfPreview?.transactions?.length) return toast('请先选择并解析 PDF 交易流水');
    openPdfFundSelection(account, pdfPreview);
    return;
  }
  const qty = num(form.holding_quantity.value), cost = num(form.book_cost.value), market = num(form.market_value.value), current = num(form.current_price.value) || (qty ? market / qty : 0), price = cost;
  if (!code || !form.name.value.trim() || !qty) return toast('请填写代码、名称和持仓数量');
  if (cost < 0 || market < 0 || current < 0) return toast('市值、成本价和现价不能为负数');
  const tradeDate = form.date.value || new Date().toISOString().slice(0, 10);
  try {
    if (assetType === '基金') await api('/api/fund-rules', { method: 'POST', body: JSON.stringify({ account, code, name: form.name.value, buy_rate: selectedBuyRate(root), buy_mode: 'external', redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) });
    await api('/api/transactions', { method: 'POST', body: JSON.stringify({ date: tradeDate, account, asset_type: assetType, code, name: form.name.value, action: '买入', quantity: qty, price, buy_fee: 0, sell_fee: 0, tax: 0, other_fee: 0, note: '手工录入当前持仓（初始成本价）' }) });
    await api('/api/prices', { method: 'POST', body: JSON.stringify({ code, name: form.name.value, asset_type: assetType, price: current }) });
    closeModal(); toast('持仓已添加，并生成初始买入流水'); await refresh();
  } catch (error) { toast(error.message); }
}

function pdfFundGroups(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const code = String(transaction.code || '').trim();
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, { code, name: transaction.name || code, transactions: [], buys: 0, sells: 0, quantity: 0 });
    const group = groups.get(code);
    group.transactions.push(transaction);
    if (transaction.action === '卖出') { group.sells += 1; group.quantity -= num(transaction.quantity); }
    else { group.buys += 1; group.quantity += num(transaction.quantity); }
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function openPdfFundSelection(account, preview) {
  const groups = pdfFundGroups(preview.transactions || []);
  closeModal();
  const rows = groups.map((group, index) => `<tr><td><input class="bulk-check pdf-fund-check" type="checkbox" data-index="${index}" checked></td><td class="code">${esc(group.code)}</td><td>${esc(group.name)}</td><td>${group.buys}</td><td>${group.sells}</td><td>${quantity(group.quantity)}</td></tr>`).join('');
  const body = `<p class="hint">这是写入数据前的最后一步。取消不想添加的基金后再确认；同一只基金的完整买卖流水会一起导入。</p><form id="pdfFundSelectionForm"><div class="bulk-delete-toolbar"><label><input class="bulk-check" id="selectAllPdfFunds" type="checkbox" checked> 全选</label><span id="pdfSelectionCount"></span></div><div class="table-wrap bulk-delete-list"><table><thead><tr><th></th><th>代码</th><th>基金名称</th><th>买入笔数</th><th>卖出笔数</th><th>期末份额</th></tr></thead><tbody>${rows}</tbody></table></div><div class="form-actions editor-save"><button class="primary" type="submit">确认导入已选基金</button></div></form>`;
  const root = modal('选择要导入的基金', body), form = $('#pdfFundSelectionForm');
  const checks = [...root.querySelectorAll('.pdf-fund-check')];
  const updateCount = () => { const selected = checks.filter(item => item.checked); root.querySelector('#pdfSelectionCount').textContent = `已选 ${selected.length} 只基金，${selected.reduce((total, item) => total + groups[Number(item.dataset.index)].transactions.length, 0)} 笔交易`; root.querySelector('#selectAllPdfFunds').checked = selected.length === checks.length; root.querySelector('#selectAllPdfFunds').indeterminate = selected.length > 0 && selected.length < checks.length; };
  root.querySelector('#selectAllPdfFunds').addEventListener('change', event => { checks.forEach(item => { item.checked = event.target.checked; }); updateCount(); });
  checks.forEach(item => item.addEventListener('change', updateCount));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const selected = checks.filter(item => item.checked).flatMap(item => groups[Number(item.dataset.index)].transactions);
    if (!selected.length) return toast('请至少选择一只基金');
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '导入中…';
    try {
      const result = await api('/api/import-pdf', { method: 'POST', body: JSON.stringify({ account, transactions: selected }) });
      closeModal(); await refresh();
      toast(`已导入 ${result.inserted} 笔基金交易${result.skipped ? `，跳过 ${result.skipped} 笔重复记录` : ''}`);
    } catch (error) { button.disabled = false; button.textContent = '确认导入已选基金'; toast(error.message); }
  });
  updateCount();
}

function openEditPositionModal(position) {
  const body = `<div class="trade-identity"><strong>${esc(position.name)}</strong><span>${esc(position.account)} · ${esc(position.code)} · ${esc(position.asset_type)}</span></div><p class="hint">修改手工录入的当前持仓快照，不会改写后续交易流水。现价继续使用总览中的行情价格。</p><form id="editPositionForm" class="form-grid">${snapshotFields({ includeCurrent: false })}<div class="form-actions" style="grid-column:1/-1"><button class="primary" type="submit">确认</button></div></form>`;
  const root = modal('修改持仓', body), form = $('#editPositionForm');
  form.market_value.value = decimal(position.market_value, 3);
  form.book_cost.value = decimal(position.avg_cost, 4);
  form.holding_quantity.value = decimal(position.quantity, 4);
  const updateSnapshot = (syncMarket = false) => { const current = num(position.current_price), cost = num(form.book_cost.value), qty = num(form.holding_quantity.value); if (syncMarket && current && qty) form.market_value.value = decimal(current * qty, 3); const market = num(form.market_value.value); form.pnl.value = qty ? decimal(market - cost * qty, 3) : ''; };
  form.market_value.addEventListener('input', () => updateSnapshot(false));
  form.book_cost.addEventListener('input', () => updateSnapshot(false));
  form.holding_quantity.addEventListener('input', () => updateSnapshot(true));
  updateSnapshot();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!num(form.holding_quantity.value)) return toast('请填写持仓数量');
    try {
      await api('/api/position-snapshot', { method: 'POST', body: JSON.stringify({ account: position.account, code: position.code, name: position.name, asset_type: position.asset_type, market_value: num(form.market_value.value), unit_cost: num(form.book_cost.value), quantity: num(form.holding_quantity.value) }) });
      closeModal(); toast('持仓已修改'); await refresh();
    } catch (error) { toast(error.message); }
  });
}

async function feePreview(payload) { return api('/api/fee-preview', { method: 'POST', body: JSON.stringify(payload) }); }

function openTradeModal(position) {
  const body = `<div class="trade-identity"><strong>${esc(position.name)}</strong><span>${esc(position.account)} · ${esc(position.code)} · ${esc(position.asset_type)}</span></div><form id="tradeForm" class="form-grid"><div class="field"><label>操作</label><select class="input" name="operation"><option>加仓</option><option>减仓</option></select></div><div class="field"><label>${position.asset_type === '基金' ? '确认日期' : '成交日期'}</label><input class="input" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>${calculatorFields('trade')}<div class="field"><label>手续费</label><input class="input fee-display" readonly value="0"></div><div class="trade-fee-note fee-summary" style="grid-column:1/-1"></div><div class="lot-preview" style="grid-column:1/-1"></div><div class="form-actions" style="grid-column:1/-1"><button class="primary" type="submit">确认</button></div></form>`;
  const root = modal('加减仓', body), form = $('#tradeForm');
  const calculator = bindCalculator(root, () => updateTradePreview(position, form, calculator), { grossFactor: () => position.asset_type === '基金' && form.operation.value === '加仓' ? 1 + num(findRule(position.account, position.code)?.buy_rate ?? state.settings.fund_buy_rate) : 1 });
  calculator.price.value = position.current_price || '';
  form.operation.addEventListener('change', () => { recalculateAmount(calculator); updateTradePreview(position, form, calculator); });
  form.date.addEventListener('change', () => updateTradePreview(position, form, calculator));
  form.addEventListener('submit', event => saveTrade(event, position, calculator));
  updateTradePreview(position, form, calculator);
}

async function updateTradePreview(position, form, calculator) {
  const qty = num(calculator.qty.value), price = num(calculator.price.value);
  if (!qty || !price) { form.querySelector('.fee-display').value = '0'; form.querySelector('.trade-fee-note').textContent = '填写金额、数量、价格中的两项后自动计算。'; return; }
  try {
    const result = await feePreview({ account: position.account, code: position.code, asset_type: position.asset_type, operation: form.operation.value, quantity: qty, price, date: form.date.value });
    const totalFee = num(result.buy_fee) + num(result.sell_fee) + num(result.tax);
    form.querySelector('.fee-display').value = decimal(totalFee, 2);
    form.querySelector('.trade-fee-note').textContent = form.operation.value === '加仓' ? `实际支出约 ¥${money(qty * price + totalFee)}` : `预计到账约 ¥${money(qty * price - totalFee)}`;
    form.querySelector('.lot-preview').innerHTML = result.lot_preview?.length ? allocationTable(result.lot_preview, false) : '';
  } catch (error) { form.querySelector('.trade-fee-note').textContent = error.message; }
}

async function saveTrade(event, position, calculator) {
  event.preventDefault(); const form = event.currentTarget;
  const qty = num(calculator.qty.value), price = num(calculator.price.value), operation = form.operation.value;
  if (!qty || !price) return toast('请在金额、数量、价格中至少填写两项');
  if (operation === '减仓' && qty > num(position.quantity) + 1e-8) return toast('减仓数量超过当前持仓');
  try {
    const fee = await feePreview({ account: position.account, code: position.code, asset_type: position.asset_type, operation, quantity: qty, price, date: form.date.value });
    const saved = await api('/api/transactions', { method: 'POST', body: JSON.stringify({ date: form.date.value, account: position.account, asset_type: position.asset_type, code: position.code, name: position.name, action: operation === '加仓' ? '买入' : '卖出', quantity: qty, price, buy_fee: num(fee.buy_fee), sell_fee: num(fee.sell_fee), tax: num(fee.tax), other_fee: 0, note: '' }) });
    await api('/api/prices', { method: 'POST', body: JSON.stringify({ code: position.code, name: position.name, asset_type: position.asset_type, price }) });
    closeModal(); await refresh();
    const cleared = findPosition(positionId(position)) || position;
    if (saved.sold_out) {
      if (confirm(`${position.name} 的持仓已经为 0，是否归档完整交易记录和盈亏？`)) await archivePosition(cleared, false);
      else toast('交易已保存，之后可在总览中归档');
    } else toast('实际交易已保存到流水');
  } catch (error) { toast(error.message); }
}

function allocationTable(items, historical = true) {
  return `<div class="allocation-box"><h4>${historical ? '本次实际卖出批次' : '预计卖出批次'}</h4><div class="table-wrap"><table><thead><tr><th>买入确认日期</th><th>卖出份额</th><th>持有天数</th><th>赎回费率</th><th>赎回费</th></tr></thead><tbody>${items.map(item => `<tr><td>${esc(item.buy_date || item.date)}</td><td>${quantity(item.quantity)}</td><td>${item.holding_days}</td><td>${percent(item.rate)}</td><td>${money(item.fee)}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderTransactions() {
  const rows = [...state.transactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('#transactions').innerHTML = `<div class="section-head"><div><h2>交易流水</h2><p>这里只记录已经确认的实际交易。基金卖出可展开查看消耗的历史买入批次。</p></div></div><div class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>账户</th><th>代码</th><th>名称</th><th>类型</th><th>操作</th><th>数量</th><th>成交金额</th><th>手续费</th><th></th></tr></thead><tbody>${rows.map(tx => { const allocations = state.sale_allocations.filter(item => item.sale_tx_id === tx.id); return `<tr><td>${esc(tx.date)}</td><td>${esc(tx.account)}</td><td class="code">${esc(tx.code)}</td><td>${esc(tx.name)}</td><td>${esc(tx.asset_type)}</td><td>${esc(tx.action)}</td><td>${quantity(tx.quantity)}</td><td>${money(num(tx.quantity) * num(tx.price))}</td><td>${money(num(tx.buy_fee) + num(tx.sell_fee) + num(tx.tax) + num(tx.other_fee))}</td><td>${allocations.length ? `<button class="ghost small-btn" data-allocation="${esc(tx.id)}">查看批次</button>` : ''}<button class="danger-btn" data-delete="${esc(tx.id)}">删除</button></td></tr>${allocations.length ? `<tr class="allocation-row" data-allocation-row="${esc(tx.id)}" style="display:none"><td colspan="10">${allocationTable(allocations)}</td></tr>` : ''}`; }).join('')}</tbody></table></div>` : '<div class="empty">暂无交易记录。</div>'}</div>`;
  $$('[data-allocation]').forEach(button => button.addEventListener('click', () => { const row = document.querySelector(`[data-allocation-row="${CSS.escape(button.dataset.allocation)}"]`); row.style.display = row.style.display === 'none' ? 'table-row' : 'none'; }));
  $$('[data-delete]').forEach(button => button.addEventListener('click', async () => { if (!confirm('确定删除这笔交易？相关持仓会重新计算。')) return; try { await api(`/api/transactions/${button.dataset.delete}`, { method: 'DELETE' }); toast('已删除'); await refresh(); } catch (error) { toast(error.message); } }));
}

async function archivePosition(position, ask = true, openAfter = true) {
  if (!position) return false;
  if (ask && !confirm(`${position.name} 的持仓已经为 0，是否归档完整交易记录和盈亏？`)) return false;
  try {
    const result = await api('/api/archives', { method: 'POST', body: JSON.stringify({ account: position.account, code: position.code }) });
    await refresh();
    toast('持仓已归档');
    if (openAfter) openArchiveModal(state.archives.find(item => item.id === result.archive.id) || result.archive);
    return true;
  } catch (error) { toast(error.message); return false; }
}

async function archiveAllCleared() {
  const rows = dashboardAccount === '__all__' ? state.positions : state.positions.filter(position => position.account === dashboardAccount);
  const cleared = rows.filter(position => Math.abs(num(position.quantity)) <= 1e-8);
  if (!cleared.length) return toast('暂无可归档的持仓');
  const scope = dashboardAccount === '__all__' ? '全部账户' : `账户“${dashboardAccount}”`;
  if (!confirm(`确定一键归档${scope}中的 ${cleared.length} 个零持仓吗？\n\n归档会保留完整交易流水和盈亏，之后可在“已归档”中查看并填写交易心得。`)) return;
  const button = $('#archiveAllCleared');
  button.disabled = true;
  button.textContent = '归档中…';
  let archived = 0;
  const failed = [];
  for (const position of cleared) {
    try {
      await api('/api/archives', { method: 'POST', body: JSON.stringify({ account: position.account, code: position.code }) });
      archived += 1;
    } catch (error) {
      failed.push(position.name || position.code);
    }
  }
  await refresh();
  if (failed.length) toast(`已归档 ${archived} 个，${failed.length} 个失败`);
  else toast(`已一键归档 ${archived} 个持仓`);
}

function archiveTable(items, emptyText) {
  if (!items.length) return `<div class="empty">${emptyText}</div>`;
  return `<div class="table-wrap"><table class="archive-table"><thead><tr><th>账户</th><th>代码</th><th>名称</th><th>类型</th><th>交易区间</th><th>最终盈亏</th><th>归档日期</th><th></th></tr></thead><tbody>${items.map(item => `<tr><td>${esc(item.account)}</td><td class="code">${esc(item.code)}</td><td><button class="link-btn" data-open-archive="${esc(item.id)}">${esc(item.name)}</button></td><td>${esc(item.asset_type)}</td><td>${esc(item.start_date || '—')} 至 ${esc(item.end_date || '—')}</td><td class="${tone(item.total_pnl)}">${money(item.total_pnl)}</td><td>${esc(String(item.archived_at || '').slice(0, 10))}</td><td><button class="ghost small-btn" data-open-archive="${esc(item.id)}">查看</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderArchives() {
  const funds = state.archives.filter(item => item.asset_type === '基金');
  const securities = state.archives.filter(item => item.asset_type !== '基金');
  $('#archives').innerHTML = `<div class="section-head"><div><h2>已归档</h2><p>清仓后的交易记录和最终盈亏保存在这里，可随时补充交易心得。</p></div><div class="section-actions"><button class="ghost danger" id="bulkDeleteArchives" type="button">批量删除</button></div></div>
    <div class="archive-grid"><section class="panel"><div class="panel-title"><h3>股票、ETF 与可转债</h3><span class="hint">${securities.length} 个归档</span></div>${archiveTable(securities, '暂无股票类归档。')}</section>
    <section class="panel"><div class="panel-title"><h3>基金</h3><span class="hint">${funds.length} 个归档</span></div>${archiveTable(funds, '暂无基金归档。')}</section></div>`;
  $$('[data-open-archive]').forEach(button => button.addEventListener('click', () => openArchiveModal(state.archives.find(item => item.id === button.dataset.openArchive))));
  $('#bulkDeleteArchives').addEventListener('click', openBulkDeleteArchives);
}

function bulkSelectionModal({ title, description, items, columns, row, endpoint, payloadKey, confirmText, doneText }) {
  if (!items.length) return toast('暂无可删除的记录');
  const rows = items.map((item, index) => `<tr><td><input class="bulk-check bulk-item-check" type="checkbox" data-index="${index}"></td>${row(item)}</tr>`).join('');
  const body = `<p class="hint">${description}</p><form id="bulkDeleteForm"><div class="bulk-delete-toolbar"><label><input class="bulk-check" id="selectAllBulkItems" type="checkbox"> 全选</label><span id="bulkSelectionCount">已选 0 项</span></div><div class="table-wrap bulk-delete-list"><table><thead><tr><th></th>${columns.map(column => `<th>${column}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><div class="form-actions editor-save"><button class="danger-btn" type="submit">删除所选</button></div></form>`;
  const root = modal(title, body), form = $('#bulkDeleteForm'), checks = [...root.querySelectorAll('.bulk-item-check')];
  const updateCount = () => { const count = checks.filter(item => item.checked).length; root.querySelector('#bulkSelectionCount').textContent = `已选 ${count} 项`; root.querySelector('#selectAllBulkItems').checked = count === checks.length; root.querySelector('#selectAllBulkItems').indeterminate = count > 0 && count < checks.length; };
  root.querySelector('#selectAllBulkItems').addEventListener('change', event => { checks.forEach(item => { item.checked = event.target.checked; }); updateCount(); });
  checks.forEach(item => item.addEventListener('change', updateCount));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const selected = checks.filter(item => item.checked).map(item => items[Number(item.dataset.index)]);
    if (!selected.length) return toast('请先选择要删除的项目');
    if (!confirm(confirmText(selected.length))) return;
    try {
      const payloadItems = payloadKey === 'ids' ? selected.map(item => item.id) : selected;
      const result = await api(endpoint, { method: 'DELETE', body: JSON.stringify({ [payloadKey]: payloadItems }) });
      closeModal(); await refresh(); toast(`${doneText}${result.deleted} 项`);
    } catch (error) { toast(error.message); }
  });
}

function openBulkDeletePositions() {
  const positions = dashboardAccount === '__all__' ? state.positions : state.positions.filter(position => position.account === dashboardAccount);
  bulkSelectionModal({ title: '批量删除持仓', description: '选择要永久删除的持仓。删除持仓会同时删除它的全部交易流水和基金费率设置。', items: positions.map(position => ({ account: position.account, code: position.code, name: position.name, asset_type: position.asset_type, quantity: position.quantity })), columns: ['账户', '代码', '名称', '类型', '持仓'], row: item => `<td>${esc(item.account)}</td><td class="code">${esc(item.code)}</td><td>${esc(item.name)}</td><td>${esc(item.asset_type)}</td><td>${quantity(item.quantity)}</td>`, endpoint: '/api/positions', payloadKey: 'items', confirmText: count => `确定永久删除选中的 ${count} 个持仓吗？\n\n对应交易流水和基金费率设置也会被删除，此操作无法撤销。`, doneText: '已删除持仓 ' });
}

function openBulkDeleteArchives() {
  bulkSelectionModal({ title: '批量删除归档', description: '选择要永久删除的归档记录。', items: state.archives.map(item => ({ id: item.id, account: item.account, code: item.code, name: item.name, asset_type: item.asset_type, archived_at: item.archived_at })), columns: ['账户', '代码', '名称', '类型', '归档日期'], row: item => `<td>${esc(item.account)}</td><td class="code">${esc(item.code)}</td><td>${esc(item.name)}</td><td>${esc(item.asset_type)}</td><td>${esc(String(item.archived_at || '').slice(0, 10))}</td>`, endpoint: '/api/archives', payloadKey: 'ids', confirmText: count => `确定永久删除选中的 ${count} 个归档吗？\n\n归档中保存的历史流水、盈亏和交易心得都会一起删除，此操作无法撤销。`, doneText: '已删除归档 ' });
}

function openArchiveModal(archive) {
  if (!archive) return;
  const rows = [...(archive.transactions || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const allocations = archive.sale_allocations || [];
  const history = rows.length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>操作</th><th>数量</th><th>成交价</th><th>成交金额</th><th>手续费</th><th>备注</th></tr></thead><tbody>${rows.map(tx => { const lots = allocations.filter(item => item.sale_tx_id === tx.id); return `<tr><td>${esc(tx.date)}</td><td>${esc(tx.action)}</td><td>${quantity(tx.quantity)}</td><td>${unitPrice(tx.price)}</td><td>${money(num(tx.quantity) * num(tx.price))}</td><td>${money(num(tx.buy_fee) + num(tx.sell_fee) + num(tx.tax) + num(tx.other_fee))}</td><td class="archive-note-cell">${esc(tx.note || '')}</td></tr>${lots.length ? `<tr class="allocation-row"><td colspan="7">${allocationTable(lots)}</td></tr>` : ''}`; }).join('')}</tbody></table></div>` : '<div class="empty">暂无交易记录。</div>';
  const body = `<div class="trade-identity"><strong>${esc(archive.name)}</strong><span>${esc(archive.account)} · ${esc(archive.code)} · ${esc(archive.asset_type)} · ${esc(archive.start_date || '—')} 至 ${esc(archive.end_date || '—')}</span></div><div class="archive-summary">${kpi('最终盈亏', `¥${money(archive.total_pnl)}`, tone(archive.total_pnl))}${kpi('已实现盈亏', `¥${money(archive.realized_pnl)}`, tone(archive.realized_pnl))}${kpi('交易笔数', String(rows.length))}</div><h3 class="archive-history-title">历史交易</h3>${history}<form id="archiveNotesForm"><div class="field archive-notes"><label>交易心得</label><textarea class="input" name="notes" rows="5" placeholder="记录这次交易做得好的地方、错误和以后需要遵守的规则">${esc(archive.notes || '')}</textarea></div><div class="form-actions editor-save"><button class="primary" type="submit">保存心得</button></div></form>`;
  modal('归档详情', body);
  $('#archiveNotesForm').addEventListener('submit', async event => { event.preventDefault(); try { await api(`/api/archives/${encodeURIComponent(archive.id)}`, { method: 'POST', body: JSON.stringify({ notes: event.currentTarget.notes.value }) }); closeModal(); toast('交易心得已保存'); await refresh(); switchView('archives'); } catch (error) { toast(error.message); } });
}

function renderSimulator() {
  const options = state.positions.filter(position => position.quantity > 1e-8).map(position => `<option value="${esc(positionId(position))}">${esc(position.account)} · ${esc(position.name)}（${esc(position.code)}）</option>`).join('');
  $('#simulator').innerHTML = `<div class="section-head"><div><h2>加减仓模拟</h2><p>仅供参考，不会保存为实际交易。</p></div></div><div class="sim-layout"><div class="panel sim-controls"><div class="form-grid"><div class="field"><label>选择持仓</label><select class="input" id="simPosition">${options}</select></div><div class="field"><label>模拟操作</label><select class="input" id="simOperation"><option>加仓</option><option>减仓</option></select></div><div class="field"><label>参考日期</label><input class="input" id="simDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>${calculatorFields('sim', { amount: '金额' })}<div class="fee-summary" id="simFeeSummary">手续费：¥0</div></div></div><div class="panel"><div class="panel-title"><h3>模拟结果</h3><span class="hint">不会进入交易流水</span></div><div id="simResults" class="sim-result"></div><div id="simLots"></div></div></div>`;
  if (!options) { $('#simulator .sim-layout').innerHTML = '<div class="empty">暂无可模拟的持仓。</div>'; return; }
  const root = $('#simulator'), calculator = bindCalculator(root, () => scheduleSimulation(calculator), { grossFactor: () => { const position = findPosition($('#simPosition')?.value); return position?.asset_type === '基金' && $('#simOperation')?.value === '加仓' ? 1 + num(findRule(position.account, position.code)?.buy_rate ?? state.settings.fund_buy_rate) : 1; } });
  ['simPosition', 'simOperation', 'simDate'].forEach(id => $(`#${id}`).addEventListener('change', () => { if (id === 'simPosition') calculator.price.value = findPosition($('#simPosition').value)?.current_price || ''; if (id !== 'simDate') recalculateAmount(calculator); scheduleSimulation(calculator); }));
  calculator.price.value = findPosition($('#simPosition').value)?.current_price || '';
  scheduleSimulation(calculator);
}

function scheduleSimulation(calculator) { clearTimeout(simTimer); simTimer = setTimeout(() => runSimulation(calculator), 180); }
async function runSimulation(calculator) {
  const position = findPosition($('#simPosition').value); if (!position) return;
  const qty = num(calculator.qty.value), price = num(calculator.price.value), operation = $('#simOperation').value;
  if (!qty || !price) { $('#simResults').innerHTML = '<div class="empty">填写金额、数量、价格中的两项即可预览。</div>'; return; }
  try {
    const fees = await feePreview({ account: position.account, code: position.code, asset_type: position.asset_type, operation, quantity: qty, price, date: $('#simDate').value });
    const fee = num(fees.buy_fee) + num(fees.sell_fee) + num(fees.tax);
    $('#simFeeSummary').textContent = `手续费：¥${money(fee)}`;
    const result = await api('/api/simulate', { method: 'POST', body: JSON.stringify({ account: position.account, code: position.code, asset_type: position.asset_type, operation, quantity: qty, price, date: $('#simDate').value, buy_fee: num(fees.buy_fee), sell_fee: num(fees.sell_fee), tax: num(fees.tax), other_fee: 0 }) });
    $('#simResults').innerHTML = `${kpi('当前持仓', quantity(result.before.quantity))}${kpi('当前成本价', unitPrice(result.before.avg_cost))}${kpi('操作后持仓', quantity(result.after.quantity))}${kpi('操作后成本价', unitPrice(result.after.avg_cost))}${kpi('操作后回本价', unitPrice(result.after.break_even))}${kpi('参考现金流', `¥${money(result.cash_flow)}`, tone(result.cash_flow))}`;
    $('#simLots').innerHTML = fees.lot_preview?.length ? allocationTable(fees.lot_preview, false) : '';
  } catch (error) { $('#simResults').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

function tierSummary(tiers) { return (tiers || []).map(tier => `${rangeLabel(num(tier.min_days), tier.max_days == null ? null : num(tier.max_days))}：${percent(tier.rate)}`).join('；'); }

function renderSettings() {
  const s = state.settings;
  $('#settings').innerHTML = `<div class="section-head"><div><h2>费率设置</h2><p>股票、ETF、可转债使用各自费率；基金费率按账户和基金代码管理。</p></div></div><form id="marketFeeForm"><section class="settings-block market-settings-block"><div class="settings-block-head"><div><h3>股票、ETF 与可转债费率</h3><span class="hint">分别设置，统一保存</span></div></div><div class="market-fee-grid"><div class="panel"><div class="panel-title"><h3>股票</h3></div>${marketFeeFields('stock', s)}</div><div class="panel"><div class="panel-title"><h3>ETF</h3></div>${marketFeeFields('etf', s)}</div><div class="panel"><div class="panel-title"><h3>可转债</h3></div>${marketFeeFields('convertible', s)}</div></div><div class="form-actions settings-save"><button class="primary" type="submit">保存</button></div></section></form><section class="settings-block fund-settings-block"><div class="settings-block-head"><div><h3>基金费率规则</h3><span class="hint">修改不会改变已经保存的历史赎回批次</span></div></div><div class="panel">${state.fund_rules.length ? `<div class="table-wrap"><table><thead><tr><th>账户</th><th>代码</th><th>基金</th><th>买入费率</th><th>赎回规则</th><th></th></tr></thead><tbody>${state.fund_rules.map(rule => `<tr><td>${esc(rule.account)}</td><td class="code">${esc(rule.code)}</td><td>${esc(rule.name)}</td><td>${percent(rule.buy_rate)}</td><td class="rule-summary">${esc(tierSummary(rule.redemption_tiers))}</td><td><button class="ghost small-btn" data-edit-rule="${esc(rule.account)}\u001f${esc(rule.code)}">修改</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">尚未保存基金规则。</div>'}</div><div class="panel"><div class="panel-title"><h3>赎回规则模板</h3><button class="ghost small-btn" id="newTemplate" type="button">新增</button></div>${state.fund_rule_templates.map(item => `<div class="template-line"><div><strong>${esc(item.name)}</strong><p>${esc(tierSummary(item.redemption_tiers))}</p></div><button class="ghost small-btn" data-edit-template="${esc(item.id)}">修改</button></div>`).join('')}</div></section>`;
  $('#marketFeeForm').addEventListener('submit', saveMarketFees);
  $$('[data-edit-rule]').forEach(button => button.addEventListener('click', () => { const [account, code] = button.dataset.editRule.split('\u001f'); openRuleEditor(findRule(account, code)); }));
  $$('[data-edit-template]').forEach(button => button.addEventListener('click', () => openTemplateEditor(state.fund_rule_templates.find(item => item.id === button.dataset.editTemplate))));
  $('#newTemplate').addEventListener('click', () => openTemplateEditor());
}

function marketFeeFields(prefix, s) {
  return `<div class="form-grid"><div class="field"><label>买入佣金（%）</label><input class="input" name="${prefix}_buy_rate" type="number" step="0.0001" value="${decimal(num(s[`${prefix}_buy_rate`]) * 100, 4)}"></div><div class="field"><label>买入最低佣金（元）</label><input class="input" name="${prefix}_buy_min" type="number" step="0.01" value="${decimal(s[`${prefix}_buy_min`], 2)}"></div><div class="field"><label>卖出佣金（%）</label><input class="input" name="${prefix}_sell_rate" type="number" step="0.0001" value="${decimal(num(s[`${prefix}_sell_rate`]) * 100, 4)}"></div><div class="field"><label>卖出最低佣金（元）</label><input class="input" name="${prefix}_sell_min" type="number" step="0.01" value="${decimal(s[`${prefix}_sell_min`], 2)}"></div><div class="field"><label>${prefix === 'stock' ? '卖出印花税' : '其他税费'}（%）</label><input class="input" name="${prefix}_${prefix === 'stock' ? 'tax_rate' : 'tax_rate'}" type="number" step="0.0001" value="${decimal(num(s[`${prefix}_tax_rate`]) * 100, 4)}"></div></div>`;
}

async function saveMarketFees(event) {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()), payload = {};
  for (const [key, value] of Object.entries(data)) payload[key] = key.endsWith('_rate') ? num(value) / 100 : num(value);
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }); toast('费率已保存'); await refresh(); } catch (error) { toast(error.message); }
}

function openRuleEditor(rule) {
  if (!rule) return;
  const body = `<div class="trade-identity"><strong>${esc(rule.name || rule.code)}</strong><span>${esc(rule.account)} · ${esc(rule.code)}</span></div><form id="ruleForm"><div class="form-grid"><div class="field"><label>买入费率</label>${rateSelect(rule.buy_rate)}</div><div class="field custom-rate-field"><label>自定义买入费率（%）</label><input class="input custom-rate" type="number" min="0" step="0.01" value="${decimal(num(rule.buy_rate) * 100, 2)}"></div><div class="field"><label>赎回规则</label><select class="input rule-source">${ruleSourceOptions('custom')}</select></div></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button></div><div class="form-actions editor-save"><button class="primary" type="submit">保存基金费率规则</button></div></form>`;
  const root = modal('修改基金费率规则', body), form = $('#ruleForm');
  const toggleCustom = () => root.querySelector('.custom-rate-field').style.display = root.querySelector('.buy-rate-select').value === 'custom' ? 'flex' : 'none';
  root.querySelector('.buy-rate-select').addEventListener('change', toggleCustom); toggleCustom();
  root.querySelector('.rule-source').addEventListener('change', event => applyRuleSource(event.target.value, root));
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  setTierEditor(root.querySelector('.tier-editor'), rule.redemption_tiers);
  form.addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/fund-rules', { method: 'POST', body: JSON.stringify({ account: rule.account, code: rule.code, name: rule.name, buy_rate: selectedBuyRate(root), buy_mode: 'external', redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) }); closeModal(); toast('基金规则已保存'); await refresh(); } catch (error) { toast(error.message); } });
}

function openPositionRule(position) {
  if (!position || position.asset_type !== '基金') return;
  openRuleEditor(findRule(position.account, position.code) || {
    account: position.account,
    code: position.code,
    name: position.name,
    buy_rate: 0,
    redemption_tiers: commonRuleTemplate()?.redemption_tiers || []
  });
}

function openTemplateEditor(template = null) {
  const body = `<form id="templateForm"><div class="field"><label>模板名称</label><input class="input template-name" value="${esc(template?.name || '')}" required></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button></div><div class="form-actions editor-save"><button class="primary" type="submit">保存规则模板</button></div></form>`;
  const root = modal(template ? '修改赎回规则模板' : '新增赎回规则模板', body), form = $('#templateForm');
  setTierEditor(root.querySelector('.tier-editor'), template?.redemption_tiers || commonRuleTemplate()?.redemption_tiers || []);
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  form.addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/fund-rule-templates', { method: 'POST', body: JSON.stringify({ id: template?.id, name: root.querySelector('.template-name').value, redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) }); closeModal(); toast('规则模板已保存'); await refresh(); } catch (error) { toast(error.message); } });
}

function render() {
  renderDashboard(); renderTransactions(); renderSimulator(); renderSettings(); renderArchives(); switchView(activeView);
}

function switchView(view) {
  activeView = view;
  $$('.view').forEach(element => element.classList.toggle('active', element.id === view));
  $$('.tab').forEach(element => element.classList.toggle('active', element.dataset.view === view));
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-trade-position]');
  if (target) { const position = findPosition(target.dataset.tradePosition); if (position) openTradeModal(position); }
  const editTarget = event.target.closest('[data-edit-position]');
  if (editTarget) { const position = findPosition(editTarget.dataset.editPosition); if (position) openEditPositionModal(position); }
  const ruleTarget = event.target.closest('[data-position-rule]');
  if (ruleTarget) openPositionRule(findPosition(ruleTarget.dataset.positionRule));
  const archiveTarget = event.target.closest('[data-archive-position]');
  if (archiveTarget) archivePosition(findPosition(archiveTarget.dataset.archivePosition));
});
$$('.tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));
$('#exportBtn').addEventListener('click', async () => { const data = await api('/api/export'), blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); toast('备份已导出'); });
$('#importFile').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { await api('/api/import', { method: 'POST', body: await file.text() }); toast('备份已导入'); await refresh(); } catch (error) { toast(error.message); } event.target.value = ''; });
$('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { window.location.href = '/'; } });
refresh().catch(error => toast(error.message));
