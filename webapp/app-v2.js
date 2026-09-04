let state = { transactions: [], prices: [], positions: [], settings: {}, fund_rules: [], fund_rule_templates: [], sale_allocations: [], accounts: [] };
let activeView = 'dashboard';
let dashboardAccount = '__all__';
let simTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const num = (value) => Number(value || 0);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const money = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const unitPrice = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const percent = (value) => `${(num(value) * 100).toFixed(2)}%`;
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

function positionTable(rows) {
  if (!rows.length) return '<div class="empty">暂无持仓。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>代码</th><th>名称</th><th>类型</th><th>当前价/净值</th><th>持仓</th><th>含费成本价</th><th>市值</th><th>总盈亏</th><th>收益率</th></tr></thead><tbody>${rows.map(position => `<tr>
    <td class="code">${esc(position.code)}</td>
    <td><button class="link-btn" data-trade-position="${esc(positionId(position))}">${esc(position.name)}</button></td>
    <td>${esc(position.asset_type)}</td>
    <td><input class="price-input" type="number" step="0.000001" data-code="${esc(position.code)}" data-name="${esc(position.name)}" data-type="${esc(position.asset_type)}" value="${num(position.current_price) || ''}" placeholder="填价格"></td>
    <td>${quantity(position.quantity)}</td><td>${unitPrice(position.avg_cost)}</td><td>${money(position.market_value)}</td>
    <td class="${tone(position.total_pnl)}">${money(position.total_pnl)}</td><td class="${tone(position.return_rate)}">${percent(position.return_rate)}</td>
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
  $('#dashboard').innerHTML = `<div class="section-head"><div><h2>账户总览</h2><p>切换账户查看独立成本、盈亏与收益率。点击持仓名称进行实际加仓或减仓。</p></div><button class="primary" id="addPosition">添加持仓</button></div>
    <div class="account-filter-bar" role="tablist" aria-label="选择账户">${accountButtons}</div>
    <div class="kpi-grid">${kpi(`${scope}市值`, `¥${money(total.market)}`)}${kpi(`${scope}成本`, `¥${money(total.cost)}`)}${kpi(`${scope}盈亏`, `¥${money(total.total)}`, tone(total.total))}${kpi(`${scope}收益率`, percent(total.rate), tone(total.rate))}</div>
    ${panels}`;
  $('#addPosition').addEventListener('click', () => openPositionModal());
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
  return `<div class="tier-row"><select class="input tier-range">${commonRanges.map(([a, b]) => `<option value="${a},${b == null ? '' : b}" ${a === start && b === end ? 'selected' : ''}>${rangeLabel(a, b)}</option>`).join('')}<option value="custom" ${matched ? 'hidden' : 'selected'}>${matched ? '自定义区间' : preview}</option><option value="custom_edit">${matched ? '自定义区间…' : '重新自定义区间…'}</option></select><input class="tier-start" type="hidden" value="${start}"><input class="tier-end" type="hidden" value="${end ?? ''}"><div class="tier-rate-wrap"><input class="input tier-rate" type="number" min="0" step="0.01" value="${(num(tier.rate) * 100).toFixed(2)}"><span>%</span></div><button type="button" class="danger-btn remove-tier">删除</button></div>`;
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
    if (source === amount && a > 0) { if (p > 0) qty.value = (a / factor / p).toFixed(4); else if (q > 0) price.value = (a / factor / q).toFixed(6); }
    if (source === qty && q > 0) { if (p > 0) amount.value = (q * p * factor).toFixed(2); else if (a > 0) price.value = (a / factor / q).toFixed(6); }
    if (source === price && p > 0) { if (q > 0) amount.value = (q * p * factor).toFixed(2); else if (a > 0) qty.value = (a / factor / p).toFixed(4); }
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

function snapshotFields() {
  return `<div class="snapshot-fields form-grid" style="grid-column:1/-1"><div class="field"><label>市值</label><input class="input snapshot-market" name="market_value" type="number" min="0" step="0.01" placeholder="当前持仓市值"></div><div class="field"><label>成本</label><input class="input snapshot-cost" name="book_cost" type="number" min="0" step="0.01" placeholder="持仓总成本"></div><div class="field"><label>持仓数量</label><input class="input snapshot-quantity" name="holding_quantity" type="number" min="0" step="0.0001" placeholder="当前持仓数量"></div><div class="field"><label>盈亏</label><input class="input snapshot-pnl" name="pnl" type="number" step="0.01" placeholder="手工填写盈亏"></div></div>`;
}

function openPositionModal() {
  const defaultRuleSource = `template:${commonRuleTemplate()?.id || ''}`;
  const body = `<p class="hint">手工录入会生成一笔初始买入交易；基金也可以直接导入 PDF 交易流水。</p><form id="positionForm" class="form-grid">
    <div class="field"><label>账户</label>${accountSelect('account_select')}</div><div class="field new-account-field"><label>新账户名称</label><input class="input" name="new_account" placeholder="输入一次，以后可下拉选择"></div>
    <div class="field"><label>类型</label><select class="input" name="asset_type"><option>股票</option><option>ETF</option><option>可转债</option><option>基金</option></select></div>
    <div class="fund-entry-field field" style="display:none"><label>基金持仓来源</label><select class="input" name="entry_mode"><option value="manual">手工填写当前持仓</option><option value="pdf">导入 PDF 交易流水</option></select></div>
    <div class="code-field field"><label>代码</label><div class="inline-field"><input class="input" name="code"><button class="ghost" id="positionLookup" type="button">查询</button></div></div>
    <div class="name-field field"><label>名称</label><input class="input" name="name"></div><div class="date-field field"><label>确认日期</label><input class="input" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></div>
    ${snapshotFields()}
    <div class="pdf-fields subpanel" style="display:none;grid-column:1/-1"><div class="panel-title"><h3>导入基金交易流水</h3></div><p class="hint">选择 PDF 后先解析预览，确认提交后才会写入交易流水。</p><input class="input pdf-file" type="file" accept="application/pdf,.pdf"><div class="pdf-preview empty">尚未选择 PDF。</div></div>
    <div class="fund-fields subpanel" style="grid-column:1/-1"><div class="panel-title"><h3>基金费率</h3></div><div class="form-grid"><div class="field"><label>买入费率</label>${rateSelect(0)}</div><div class="field custom-rate-field" style="display:none"><label>自定义买入费率（%）</label><input class="input custom-rate" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>赎回规则</label><select class="input rule-source">${ruleSourceOptions(defaultRuleSource)}</select></div></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button><button class="ghost save-template" type="button">另存为模板</button></div></div>
    <div class="form-actions" style="grid-column:1/-1"><button class="primary" type="submit">保存持仓</button></div></form>`;
  const root = modal('添加持仓', body), form = $('#positionForm');
  let pdfPreview = null;
  const updateAccount = () => { root.querySelector('.new-account-field').style.display = form.account_select.value === '__new__' ? 'flex' : 'none'; };
  const updateType = () => { const fund = form.asset_type.value === '基金'; const pdf = fund && form.entry_mode.value === 'pdf'; root.querySelector('.fund-entry-field').style.display = fund ? 'flex' : 'none'; root.querySelector('.fund-fields').style.display = fund && !pdf ? 'block' : 'none'; root.querySelector('.snapshot-fields').style.display = pdf ? 'none' : 'grid'; root.querySelector('.pdf-fields').style.display = pdf ? 'block' : 'none'; root.querySelector('.code-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('.name-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('.date-field').style.display = pdf ? 'none' : 'flex'; root.querySelector('button[type="submit"]').textContent = pdf ? '确认导入' : '保存持仓'; };
  form.account_select.addEventListener('change', updateAccount); form.asset_type.addEventListener('change', updateType); form.entry_mode.addEventListener('change', updateType);
  root.querySelector('.buy-rate-select').addEventListener('change', event => { root.querySelector('.custom-rate-field').style.display = event.target.value === 'custom' ? 'flex' : 'none'; });
  root.querySelector('.rule-source').addEventListener('change', event => applyRuleSource(event.target.value, root));
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  root.querySelector('.save-template').addEventListener('click', () => saveTemplateFrom(root));
  root.querySelector('.pdf-file').addEventListener('change', event => { const file = event.target.files[0]; if (!file) return; const preview = root.querySelector('.pdf-preview'); preview.textContent = '正在解析…'; const reader = new FileReader(); reader.onload = async () => { try { const result = await api('/api/import-pdf-preview', { method: 'POST', body: JSON.stringify({ filename: file.name, data: String(reader.result).split(',')[1] }) }); pdfPreview = result; preview.innerHTML = `<strong>${esc(file.name)}</strong><br>共 ${result.pages} 页，识别买入 ${result.buy_count} 笔、卖出 ${result.sell_count} 笔，其中跨 TA 转换 ${result.conversion_count} 笔。${result.warnings?.length ? `<p class="negative">需核对：${esc(result.warnings.slice(0, 3).join('；'))}${result.warnings.length > 3 ? '…' : ''}</p>` : '<p class="positive">未发现解析异常。</p>'}`; } catch (error) { pdfPreview = null; preview.textContent = error.message; } }; reader.readAsDataURL(file); });
  root.querySelector('#positionLookup').addEventListener('click', async () => { try { const item = await lookupAsset(form.code.value.trim()); form.code.value = item.code; form.name.value = item.name; form.asset_type.value = item.asset_type; updateType(); toast(`已识别：${item.name}`); } catch (error) { toast(error.message); } });
  form.addEventListener('submit', event => saveNewPosition(event, root, pdfPreview));
  setTierEditor(root.querySelector('.tier-editor'), commonRuleTemplate()?.redemption_tiers || []);
  updateAccount(); updateType();
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
  if (!qty || !price) { form.querySelector('.fee-display').value = '0.00'; return; }
  if (form.asset_type.value === '基金') {
    const amount = qty * price, rate = selectedBuyRate(form);
    form.querySelector('.fee-display').value = (amount * rate).toFixed(2);
    return;
  }
  try {
    const result = await feePreview({ account: selectedAccount(form), code: form.code.value, asset_type: form.asset_type.value, operation: '加仓', quantity: qty, price });
    form.querySelector('.fee-display').value = num(result.buy_fee).toFixed(2);
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
  if (pdfMode) { if (!pdfPreview?.transactions?.length) return toast('请先选择并解析 PDF 交易流水'); try { const result = await api('/api/import-pdf', { method: 'POST', body: JSON.stringify({ account, transactions: pdfPreview.transactions }) }); closeModal(); toast(`已导入 ${result.inserted} 笔基金交易${result.skipped ? `，跳过 ${result.skipped} 笔重复记录` : ''}`); await refresh(); } catch (error) { toast(error.message); } return; }
  const qty = num(form.holding_quantity.value), cost = num(form.book_cost.value), market = num(form.market_value.value), pnl = num(form.pnl.value), price = qty ? cost / qty : 0;
  if (!code || !form.name.value.trim() || !qty) return toast('请填写代码、名称和持仓数量');
  if (form.pnl.value.trim() === '') return toast('请填写盈亏');
  if (cost < 0 || market < 0) return toast('市值和成本不能为负数');
  try {
    if (assetType === '基金') await api('/api/fund-rules', { method: 'POST', body: JSON.stringify({ account, code, name: form.name.value, buy_rate: selectedBuyRate(root), buy_mode: 'external', redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) });
    await api('/api/transactions', { method: 'POST', body: JSON.stringify({ date: form.date.value, account, asset_type: assetType, code, name: form.name.value, action: '买入', quantity: qty, price, buy_fee: 0, sell_fee: 0, tax: 0, other_fee: 0, note: '手工录入当前持仓（初始成本）' }) });
    await api('/api/prices', { method: 'POST', body: JSON.stringify({ code, name: form.name.value, asset_type: assetType, price: qty ? market / qty : 0, pnl_override: pnl }) });
    closeModal(); toast('持仓已添加，并生成初始买入流水'); await refresh();
  } catch (error) { toast(error.message); }
}

async function feePreview(payload) { return api('/api/fee-preview', { method: 'POST', body: JSON.stringify(payload) }); }

function openTradeModal(position) {
  const body = `<div class="trade-identity"><strong>${esc(position.name)}</strong><span>${esc(position.account)} · ${esc(position.code)} · ${esc(position.asset_type)}</span></div><form id="tradeForm" class="form-grid"><div class="field"><label>操作</label><select class="input" name="operation"><option>加仓</option><option>减仓</option></select></div><div class="field"><label>${position.asset_type === '基金' ? '确认日期' : '成交日期'}</label><input class="input" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>${calculatorFields('trade')}<div class="field"><label>手续费</label><input class="input fee-display" readonly value="0.00"></div><div class="trade-fee-note fee-summary" style="grid-column:1/-1"></div><div class="lot-preview" style="grid-column:1/-1"></div><div class="form-actions" style="grid-column:1/-1"><button class="primary" type="submit">确认</button></div></form>`;
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
  if (!qty || !price) { form.querySelector('.fee-display').value = '0.00'; form.querySelector('.trade-fee-note').textContent = '填写金额、数量、价格中的两项后自动计算。'; return; }
  try {
    const result = await feePreview({ account: position.account, code: position.code, asset_type: position.asset_type, operation: form.operation.value, quantity: qty, price, date: form.date.value });
    const totalFee = num(result.buy_fee) + num(result.sell_fee) + num(result.tax);
    form.querySelector('.fee-display').value = totalFee.toFixed(2);
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
    await api('/api/transactions', { method: 'POST', body: JSON.stringify({ date: form.date.value, account: position.account, asset_type: position.asset_type, code: position.code, name: position.name, action: operation === '加仓' ? '买入' : '卖出', quantity: qty, price, buy_fee: num(fee.buy_fee), sell_fee: num(fee.sell_fee), tax: num(fee.tax), other_fee: 0, note: '' }) });
    await api('/api/prices', { method: 'POST', body: JSON.stringify({ code: position.code, name: position.name, asset_type: position.asset_type, price }) });
    closeModal(); toast('实际交易已保存到流水'); await refresh();
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

function renderSimulator() {
  const options = state.positions.filter(position => position.quantity > 1e-8).map(position => `<option value="${esc(positionId(position))}">${esc(position.account)} · ${esc(position.name)}（${esc(position.code)}）</option>`).join('');
  $('#simulator').innerHTML = `<div class="section-head"><div><h2>加减仓模拟</h2><p>仅供参考，不会保存为实际交易。</p></div></div><div class="sim-layout"><div class="panel sim-controls"><div class="form-grid"><div class="field"><label>选择持仓</label><select class="input" id="simPosition">${options}</select></div><div class="field"><label>模拟操作</label><select class="input" id="simOperation"><option>加仓</option><option>减仓</option></select></div><div class="field"><label>参考日期</label><input class="input" id="simDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>${calculatorFields('sim', { amount: '金额' })}<div class="fee-summary" id="simFeeSummary">手续费：¥0.00</div></div></div><div class="panel"><div class="panel-title"><h3>模拟结果</h3><span class="hint">不会进入交易流水</span></div><div id="simResults" class="sim-result"></div><div id="simLots"></div></div></div>`;
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
  return `<div class="form-grid"><div class="field"><label>买入佣金（%）</label><input class="input" name="${prefix}_buy_rate" type="number" step="0.0001" value="${(num(s[`${prefix}_buy_rate`]) * 100).toFixed(4)}"></div><div class="field"><label>买入最低佣金（元）</label><input class="input" name="${prefix}_buy_min" type="number" step="0.01" value="${num(s[`${prefix}_buy_min`])}"></div><div class="field"><label>卖出佣金（%）</label><input class="input" name="${prefix}_sell_rate" type="number" step="0.0001" value="${(num(s[`${prefix}_sell_rate`]) * 100).toFixed(4)}"></div><div class="field"><label>卖出最低佣金（元）</label><input class="input" name="${prefix}_sell_min" type="number" step="0.01" value="${num(s[`${prefix}_sell_min`])}"></div><div class="field"><label>${prefix === 'stock' ? '卖出印花税' : '其他税费'}（%）</label><input class="input" name="${prefix}_${prefix === 'stock' ? 'tax_rate' : 'tax_rate'}" type="number" step="0.0001" value="${(num(s[`${prefix}_tax_rate`]) * 100).toFixed(4)}"></div></div>`;
}

async function saveMarketFees(event) {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()), payload = {};
  for (const [key, value] of Object.entries(data)) payload[key] = key.endsWith('_rate') ? num(value) / 100 : num(value);
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }); toast('费率已保存'); await refresh(); } catch (error) { toast(error.message); }
}

function openRuleEditor(rule) {
  if (!rule) return;
  const body = `<div class="trade-identity"><strong>${esc(rule.name || rule.code)}</strong><span>${esc(rule.account)} · ${esc(rule.code)}</span></div><form id="ruleForm"><div class="form-grid"><div class="field"><label>买入费率</label>${rateSelect(rule.buy_rate)}</div><div class="field custom-rate-field"><label>自定义买入费率（%）</label><input class="input custom-rate" type="number" min="0" step="0.01" value="${(num(rule.buy_rate) * 100).toFixed(2)}"></div><div class="field"><label>赎回规则</label><select class="input rule-source">${ruleSourceOptions('custom')}</select></div></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button></div><div class="form-actions editor-save"><button class="primary" type="submit">保存基金费率规则</button></div></form>`;
  const root = modal('修改基金费率规则', body), form = $('#ruleForm');
  const toggleCustom = () => root.querySelector('.custom-rate-field').style.display = root.querySelector('.buy-rate-select').value === 'custom' ? 'flex' : 'none';
  root.querySelector('.buy-rate-select').addEventListener('change', toggleCustom); toggleCustom();
  root.querySelector('.rule-source').addEventListener('change', event => applyRuleSource(event.target.value, root));
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  setTierEditor(root.querySelector('.tier-editor'), rule.redemption_tiers);
  form.addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/fund-rules', { method: 'POST', body: JSON.stringify({ account: rule.account, code: rule.code, name: rule.name, buy_rate: selectedBuyRate(root), buy_mode: 'external', redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) }); closeModal(); toast('基金规则已保存'); await refresh(); } catch (error) { toast(error.message); } });
}

function openTemplateEditor(template = null) {
  const body = `<form id="templateForm"><div class="field"><label>模板名称</label><input class="input template-name" value="${esc(template?.name || '')}" required></div><div class="tier-editor"></div><div class="form-actions"><button class="ghost add-tier" type="button">增加一档</button></div><div class="form-actions editor-save"><button class="primary" type="submit">保存规则模板</button></div></form>`;
  const root = modal(template ? '修改赎回规则模板' : '新增赎回规则模板', body), form = $('#templateForm');
  setTierEditor(root.querySelector('.tier-editor'), template?.redemption_tiers || commonRuleTemplate()?.redemption_tiers || []);
  root.querySelector('.add-tier').addEventListener('click', () => appendTier(root.querySelector('.tier-editor')));
  form.addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/fund-rule-templates', { method: 'POST', body: JSON.stringify({ id: template?.id, name: root.querySelector('.template-name').value, redemption_tiers: collectTiers(root.querySelector('.tier-editor')) }) }); closeModal(); toast('规则模板已保存'); await refresh(); } catch (error) { toast(error.message); } });
}

function render() {
  renderDashboard(); renderTransactions(); renderSimulator(); renderSettings(); switchView(activeView);
}

function switchView(view) {
  activeView = view;
  $$('.view').forEach(element => element.classList.toggle('active', element.id === view));
  $$('.tab').forEach(element => element.classList.toggle('active', element.dataset.view === view));
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-trade-position]');
  if (target) { const position = findPosition(target.dataset.tradePosition); if (position) openTradeModal(position); }
});
$$('.tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));
$('#exportBtn').addEventListener('click', async () => { const data = await api('/api/export'), blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); toast('备份已导出'); });
$('#importFile').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { await api('/api/import', { method: 'POST', body: await file.text() }); toast('备份已导入'); await refresh(); } catch (error) { toast(error.message); } event.target.value = ''; });
$('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { window.location.href = '/'; } });
refresh().catch(error => toast(error.message));
