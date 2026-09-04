#!/usr/bin/env python3
import json
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
import uuid
import base64
import io
import re
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get('PORTFOLIO_DB', ROOT / 'data' / 'portfolio.db'))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
SESSION_TTL = 60 * 60 * 24 * 14
PASSWORD_ITERATIONS = 600_000
SESSIONS = {}

DEFAULT_SETTINGS = {
    'stock_buy_rate': 0.0003, 'stock_buy_min': 5.0,
    'stock_sell_rate': 0.0003, 'stock_sell_min': 5.0,
    'stock_tax_rate': 0.001,
    'etf_buy_rate': 0.0003, 'etf_buy_min': 5.0,
    'etf_sell_rate': 0.0003, 'etf_sell_min': 5.0,
    'etf_tax_rate': 0.0,
    'convertible_buy_rate': 0.0003, 'convertible_buy_min': 5.0,
    'convertible_sell_rate': 0.0003, 'convertible_sell_min': 5.0,
    'convertible_tax_rate': 0.0,
    'fund_buy_rate': 0.0015, 'fund_sell_rate': 0.005,
}

PDF_TRANSACTION_TYPES = ('定投买入', '用户买入', '营销买入', '用户认购', '定投卖出', '用户卖出', '用户跨TA转换', '分红')


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('''CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, account TEXT NOT NULL,
        asset_type TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
        action TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
        price REAL NOT NULL DEFAULT 0, buy_fee REAL NOT NULL DEFAULT 0,
        sell_fee REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
        other_fee REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '')''')
    conn.execute('''CREATE TABLE IF NOT EXISTS prices (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, asset_type TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, pnl_override REAL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value REAL NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS fund_rules (
        code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
        buy_rate REAL NOT NULL DEFAULT 0.0015, buy_min REAL NOT NULL DEFAULT 0,
        buy_mode TEXT NOT NULL DEFAULT 'external',
        redemption_tiers TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT '')''')
    conn.execute('''CREATE TABLE IF NOT EXISTS fund_rules_v2 (
        account TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        buy_rate REAL NOT NULL DEFAULT 0.0015, buy_min REAL NOT NULL DEFAULT 0,
        buy_mode TEXT NOT NULL DEFAULT 'external', redemption_tiers TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(account, code))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS fund_rule_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, redemption_tiers TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT '')''')
    conn.execute('''CREATE TABLE IF NOT EXISTS fund_sale_allocations (
        id TEXT PRIMARY KEY, sale_tx_id TEXT NOT NULL, buy_tx_id TEXT NOT NULL,
        account TEXT NOT NULL, code TEXT NOT NULL, buy_date TEXT NOT NULL,
        quantity REAL NOT NULL, holding_days INTEGER NOT NULL, rate REAL NOT NULL, fee REAL NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS position_archives (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, code TEXT NOT NULL,
        name TEXT NOT NULL, asset_type TEXT NOT NULL, archived_at TEXT NOT NULL,
        start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '',
        realized_pnl REAL NOT NULL DEFAULT 0, total_pnl REAL NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', transactions_json TEXT NOT NULL DEFAULT '[]',
        allocations_json TEXT NOT NULL DEFAULT '[]')''')
    conn.execute('''CREATE TABLE IF NOT EXISTS auth_users (
        username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
        salt TEXT NOT NULL, iterations INTEGER NOT NULL,
        created_at TEXT NOT NULL)''')
    price_columns = {row[1] for row in conn.execute('PRAGMA table_info(prices)')}
    if 'pnl_override' not in price_columns:
        conn.execute('ALTER TABLE prices ADD COLUMN pnl_override REAL')
    # 旧版本数据库保持兼容；PDF 导入使用 note 保存原订单号和转换编号。
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, value))
    template = [{'min_days': 0, 'max_days': 7, 'rate': 0.015}, {'min_days': 7, 'max_days': 30, 'rate': 0.0075}, {'min_days': 30, 'max_days': 180, 'rate': 0.005}, {'min_days': 180, 'max_days': 360, 'rate': 0}, {'min_days': 360, 'max_days': None, 'rate': 0}]
    conn.execute('INSERT OR IGNORE INTO fund_rule_templates VALUES (?,?,?,?)', ('common', '常用赎回规则', json.dumps(template, ensure_ascii=False), date.today().isoformat()))
    old_template = json.dumps([{'min_days': 0, 'max_days': 7, 'rate': 0.015}, {'min_days': 7, 'max_days': 30, 'rate': 0.0075}, {'min_days': 30, 'max_days': 180, 'rate': 0.005}, {'min_days': 180, 'max_days': None, 'rate': 0}], ensure_ascii=False)
    conn.execute('UPDATE fund_rule_templates SET redemption_tiers=?, updated_at=? WHERE id=? AND redemption_tiers=?', (json.dumps(template, ensure_ascii=False), date.today().isoformat(), 'common', old_template))
    conn.execute('''INSERT OR IGNORE INTO fund_rules_v2(account,code,name,buy_rate,buy_min,buy_mode,redemption_tiers,updated_at)
        SELECT DISTINCT t.account,r.code,r.name,r.buy_rate,r.buy_min,r.buy_mode,r.redemption_tiers,r.updated_at
        FROM fund_rules r JOIN transactions t ON t.code=r.code AND t.asset_type='基金' ''')
    conn.execute('''INSERT OR IGNORE INTO fund_rules_v2(account,code,name,buy_rate,buy_min,buy_mode,redemption_tiers,updated_at)
        SELECT DISTINCT t.account,t.code,t.name,0.0015,0,'external',?,?
        FROM transactions t WHERE t.asset_type='基金' ''', (json.dumps(template, ensure_ascii=False), date.today().isoformat()))
    # 将旧版“持有天数 ≥ 180天”的无上限档位展开为 180～360、360天以上，保持费率不变。
    for table in ('fund_rules', 'fund_rules_v2', 'fund_rule_templates'):
        key_columns = 'code' if table == 'fund_rules' else ('account, code' if table == 'fund_rules_v2' else 'id')
        rows = conn.execute(f'SELECT {key_columns}, redemption_tiers FROM {table}').fetchall()
        for row in rows:
            try:
                tiers = json.loads(row['redemption_tiers'] or '[]')
            except (TypeError, ValueError):
                continue
            if not tiers:
                continue
            last = tiers[-1]
            if number(last.get('min_days', 0)) == 180 and last.get('max_days') is None:
                rate = number(last.get('rate', 0))
                last['max_days'] = 360
                tiers.append({'min_days': 360, 'max_days': None, 'rate': rate})
                where = 'code=?' if table == 'fund_rules' else ('account=? AND code=?' if table == 'fund_rules_v2' else 'id=?')
                params = tuple(row[column] for column in key_columns.split(', '))
                conn.execute(f'UPDATE {table} SET redemption_tiers=?, updated_at=? WHERE {where}', (json.dumps(tiers, ensure_ascii=False), date.today().isoformat(), *params))
    conn.commit()
    return conn


def _pdf_number(value):
    try:
        return float(str(value).replace(',', ''))
    except (TypeError, ValueError):
        return 0.0


def _pdf_date(value):
    match = re.search(r'(20\d{2})/(\d{1,2})/(\d{1,2})', str(value))
    return f'{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}' if match else ''


def _normalize_pdf_text(text):
    text = str(text or '').replace('\u00a0', ' ')
    text = re.sub(r'(\d{4}/\d{2}/\d)\s+(\d)', r'\1\2', text)
    text = re.sub(r'(20\d{2}/\d{2}/\d)\s+(\d)', r'\1\2', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def parse_fund_pdf(pdf_bytes):
    """Parse Ant fund statement rows into the application's transaction shape.

    The statement is text based but table cells may wrap across lines. We split on
    the leading YYYYMMDD trade date, then parse the stable numeric tail after the
    six-digit fund code. No file is persisted by this function.
    """
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError('服务器未安装 PDF 解析组件，请重新构建镜像') from exc
    reader = PdfReader(io.BytesIO(pdf_bytes))
    text = _normalize_pdf_text(' '.join(page.extract_text() or '' for page in reader.pages))
    chunks = re.split(r'(?=(?:^|\s)(20\d{6})(?:\s|$))', text)
    rows, warnings = [], []
    # re.split with a capturing group leaves the date as a separate item.
    rebuilt = []
    index = 0
    while index < len(chunks):
        item = chunks[index].strip()
        if re.fullmatch(r'20\d{6}', item) and index + 1 < len(chunks):
            rebuilt.append(item + ' ' + chunks[index + 1].strip())
            index += 2
        else:
            index += 1
    last_conversion_by_date = {}
    for chunk in rebuilt:
        type_match = re.search(r'(定投买入|用户买入|营销买入|用户认购|定投卖出|用户卖出|用户跨\s*TA转换|分红)', chunk)
        if not type_match:
            continue
        transaction_type = re.sub(r'\s+', '', type_match.group(1))
        trade_date_raw = re.match(r'(20\d{6})', chunk)
        if not trade_date_raw:
            continue
        trade_date = f'{trade_date_raw.group(1)[:4]}-{trade_date_raw.group(1)[4:6]}-{trade_date_raw.group(1)[6:]}'
        prefix = chunk[:type_match.start()]
        order_numbers = re.findall(r'(?<!\d)\d{8}(?!\d)', prefix)
        order_id = order_numbers[-1] if order_numbers else ''
        # Page breaks can leave only the transfer-account constants before a
        # continuation row. Reuse the preceding transfer order for that date.
        if order_id in ('00108007', '00041500', '22041500', '24041500'):
            order_id = last_conversion_by_date.get(trade_date_raw.group(1), order_id)
        code_matches = list(re.finditer(r'(?<!\d)\d{6}(?!\d)', chunk[type_match.end():]))
        if not code_matches:
            warnings.append(f'{trade_date} {transaction_type}：未找到基金代码')
            continue
        code_match = code_matches[0]
        code = code_match.group(0)
        name = re.sub(r'\s+', '', chunk[type_match.end():type_match.end() + code_match.start()]).strip()
        # Keep punctuation and letters in names, but discard a stray page marker.
        name = re.sub(r'\d+\s*/\s*\d+', '', name).strip() or code
        tail = chunk[type_match.end() + code_match.end():]
        confirm_match = re.search(r'(20\d{2}/\d{2}/\d{2})', tail)
        confirm_date = _pdf_date(confirm_match.group(1)) if confirm_match else trade_date
        numeric_tail = tail[:confirm_match.start()] if confirm_match else tail
        numbers = re.findall(r'(?<![\d.])\d+(?:\.\d+)?', numeric_tail)
        slash = '/' in numeric_tail
        try:
            if slash and len(numbers) >= 4:
                app_amount, confirm_amount, confirm_shares, fee = map(_pdf_number, numbers[:4])
                action = '买入'
                quantity = confirm_shares
                price = (confirm_amount - fee) / quantity if quantity else 0.0
                # For conversion-in rows the application/confirmation amount is
                # the transferred principal, and the same buy representation applies.
            elif len(numbers) >= 5:
                _, app_shares, confirm_amount, confirm_shares, fee = map(_pdf_number, numbers[:5])
                action = '卖出'
                quantity = confirm_shares or app_shares
                price = confirm_amount / quantity if quantity else 0.0
            else:
                warnings.append(f'{trade_date} {code}：金额或份额列无法识别')
                continue
        except (TypeError, ValueError):
            warnings.append(f'{trade_date} {code}：数字格式无法识别')
            continue
        if transaction_type == '分红':
            warnings.append(f'{trade_date} {code}：分红记录暂不自动导入，请在预览中核对')
            continue
        conversion_id = f'{trade_date_raw.group(1)}-{order_id}' if transaction_type == '用户跨TA转换' else ''
        if conversion_id:
            last_conversion_by_date[trade_date_raw.group(1)] = order_id
        note = f'PDF导入 · {transaction_type} · 订单号 {order_id}'
        if conversion_id:
            note += f' · 跨TA转换 {conversion_id}'
        rows.append({'id': str(uuid.uuid4()), 'date': confirm_date, 'account': '默认账户',
                     'asset_type': '基金', 'code': code, 'name': name, 'action': action,
                     'quantity': quantity, 'price': max(0.0, price),
                     'buy_fee': fee if action == '买入' else 0.0,
                     'sell_fee': fee if action == '卖出' else 0.0,
                     'tax': 0.0, 'other_fee': 0.0, 'note': note})
    if not rows:
        raise ValueError('没有识别到基金交易明细，请确认 PDF 是蚂蚁基金交易明细原文件')
    conversion_ids = {match.group(1) for row in rows for match in [re.search(r'跨TA转换 (\d{8}-\d{8})', row['note'])] if match}
    return {'transactions': rows, 'pages': len(reader.pages), 'warnings': warnings,
            'conversion_count': len(conversion_ids),
            'buy_count': sum(1 for row in rows if row['action'] == '买入'),
            'sell_count': sum(1 for row in rows if row['action'] == '卖出')}


def auth_user(conn):
    return conn.execute('SELECT username, password_hash, salt, iterations FROM auth_users LIMIT 1').fetchone()


def password_digest(password, salt, iterations=PASSWORD_ITERATIONS):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations).hex()


def save_auth_user(conn, username, password):
    salt = secrets.token_bytes(16)
    digest = password_digest(password, salt)
    conn.execute('DELETE FROM auth_users')
    conn.execute('INSERT INTO auth_users VALUES (?,?,?,?,?)', (username, digest, salt.hex(), PASSWORD_ITERATIONS, datetime.now().isoformat(timespec='seconds')))
    conn.commit()


def verify_password(row, password):
    try:
        digest = password_digest(password, bytes.fromhex(row['salt']), int(row['iterations']))
    except (KeyError, TypeError, ValueError):
        return False
    return hmac.compare_digest(digest, row['password_hash'])


def cleanup_sessions():
    now = time.time()
    for token, expires in list(SESSIONS.items()):
        if expires <= now:
            SESSIONS.pop(token, None)


def auth_page(setup=False):
    title = '首次设置账户' if setup else '登录'
    hint = '第一次使用，请设置登录账号和密码。' if setup else '请输入登录账号和密码。'
    endpoint = '/api/setup' if setup else '/api/login'
    fields = '<label>账号<input name="username" autocomplete="username" required maxlength="64"></label><label>密码<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>'
    if setup:
        fields += '<label>确认密码<input name="confirm" type="password" autocomplete="new-password" required minlength="8"></label>'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · 基金股票账户管理</title><style>
      :root{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}}body{{margin:0;min-height:100vh;display:grid;place-items:center}}.card{{width:min(390px,calc(100vw - 40px));box-sizing:border-box;background:#fff;border:1px solid #dbe3ef;border-radius:18px;padding:30px;box-shadow:0 16px 40px #23395d18}}h1{{margin:0 0 8px;font-size:24px}}p{{color:#6d7b91;margin:0 0 24px}}label{{display:block;font-size:14px;color:#56657b;margin:14px 0 0}}input{{width:100%;box-sizing:border-box;margin-top:7px;border:1px solid #ccd7e6;border-radius:9px;padding:12px;font-size:16px}}button{{width:100%;margin-top:22px;border:0;border-radius:9px;padding:12px;background:#246bfe;color:#fff;font-size:16px;cursor:pointer}}.error{{min-height:20px;margin-top:14px;color:#d14343;font-size:14px}}</style></head><body><form class="card" id="authForm"><h1>{title}</h1><p>{hint}</p>{fields}<button type="submit">{'完成设置' if setup else '登录'}</button><div class="error" id="error"></div></form><script>
      const form=document.getElementById('authForm');form.addEventListener('submit',async e=>{{e.preventDefault();const data=Object.fromEntries(new FormData(form));const error=document.getElementById('error');if(data.password!==data.confirm&&{str(setup).lower()}){{error.textContent='两次输入的密码不一致';return}};try{{const r=await fetch('{endpoint}',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(data)}});const body=await r.json().catch(()=>({{}}));if(!r.ok)throw Error(body.error||'操作失败');location.href='/';}}catch(err){{error.textContent=err.message;}}}});</script></body></html>'''.encode('utf-8')


def number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        raise ValueError('数量、价格和费用必须是数字')


def row_to_dict(row):
    return dict(row)


def all_transactions(conn):
    return [row_to_dict(r) for r in conn.execute('SELECT * FROM transactions ORDER BY date, id')]


def all_prices(conn):
    return [row_to_dict(r) for r in conn.execute('SELECT * FROM prices ORDER BY code')]


def get_settings(conn):
    values = dict(DEFAULT_SETTINGS)
    values.update({r['key']: r['value'] for r in conn.execute('SELECT key, value FROM settings')})
    return values


def all_fund_rules(conn):
    result = []
    for row in conn.execute('SELECT * FROM fund_rules_v2 ORDER BY account, code'):
        item = row_to_dict(row)
        try:
            item['redemption_tiers'] = json.loads(item.get('redemption_tiers') or '[]')
        except json.JSONDecodeError:
            item['redemption_tiers'] = []
        tiers = sorted(item['redemption_tiers'], key=lambda tier: number(tier.get('min_days', 0)))
        for index, tier in enumerate(tiers):
            if 'max_days' not in tier:
                tier['max_days'] = number(tiers[index + 1].get('min_days')) if index + 1 < len(tiers) else None
        item['redemption_tiers'] = tiers
        result.append(item)
    return result


def fund_rule_map(conn):
    return {(r['account'], r['code']): r for r in all_fund_rules(conn)}


def all_rule_templates(conn):
    result = []
    for row in conn.execute('SELECT * FROM fund_rule_templates ORDER BY name'):
        item = row_to_dict(row)
        try:
            item['redemption_tiers'] = json.loads(item.get('redemption_tiers') or '[]')
        except json.JSONDecodeError:
            item['redemption_tiers'] = []
        result.append(item)
    return result


def all_sale_allocations(conn):
    return [row_to_dict(r) for r in conn.execute('SELECT * FROM fund_sale_allocations ORDER BY buy_date, id')]


def all_archives(conn):
    result = []
    for row in conn.execute('SELECT * FROM position_archives ORDER BY archived_at DESC, id DESC'):
        item = row_to_dict(row)
        try:
            item['transactions'] = json.loads(item.pop('transactions_json') or '[]')
        except (TypeError, ValueError):
            item['transactions'] = []
        try:
            item['sale_allocations'] = json.loads(item.pop('allocations_json') or '[]')
        except (TypeError, ValueError):
            item['sale_allocations'] = []
        result.append(item)
    return result


def imported_sale_allocations(transactions, candidate):
    """Allocate a statement sell fee across FIFO lots while preserving its amount."""
    if candidate.get('asset_type') != '基金' or candidate.get('action') != '卖出':
        return []
    qty = number(candidate.get('quantity'))
    sale_fee = number(candidate.get('sell_fee'))
    if qty <= 0:
        return []
    lots = build_fund_lots(transactions, str(candidate.get('account', '')).strip(), str(candidate.get('code', '')).strip())
    left, base_total = qty, 0.0
    selected = []
    for lot in lots:
        if left <= 1e-8:
            break
        used = min(left, number(lot.get('quantity')))
        base = used * number(candidate.get('price'))
        selected.append((lot, used, base))
        base_total += base
        left -= used
    if left > 1e-8:
        raise ValueError(f"{candidate.get('code')} 卖出数量超过导入前持仓（缺少 {left:.4f} 份历史买入记录）")
    return [{'id': str(uuid.uuid4()), 'sale_tx_id': candidate['id'], 'buy_tx_id': lot.get('buy_tx_id', ''),
             'account': candidate.get('account', ''), 'code': candidate.get('code', ''), 'buy_date': lot.get('date', ''),
             'quantity': used, 'holding_days': days_between(lot.get('date', ''), candidate.get('date', '')),
             'rate': (sale_fee * base / base_total / base) if sale_fee and base_total and base else 0.0,
             'fee': sale_fee * base / base_total if base_total else 0.0} for lot, used, base in selected]


def days_between(start, end):
    try:
        a = datetime.strptime(str(start)[:10], '%Y-%m-%d').date()
        b = datetime.strptime(str(end)[:10], '%Y-%m-%d').date()
        return max(0, (b - a).days)
    except (TypeError, ValueError):
        return 0


def redemption_rate(rule, holding_days, fallback):
    tiers = (rule or {}).get('redemption_tiers') or []
    parsed = []
    for tier in tiers:
        try:
            parsed.append((float(tier.get('min_days', 0)), float(tier.get('rate', 0))))
        except (TypeError, ValueError, AttributeError):
            pass
    selected = None
    for minimum, rate in sorted(parsed):
        if holding_days >= minimum:
            selected = rate
    return selected if selected is not None else fallback


def calculate(transactions, prices, fund_rules=None):
    fund_rules = fund_rules or {}
    states = {}
    for tx in sorted(transactions, key=lambda x: (x.get('date', ''), x.get('id', ''))):
        code = str(tx.get('code', '')).strip()
        account = str(tx.get('account', '')).strip() or '默认账户'
        if not code:
            continue
        action = tx.get('action', '')
        qty = number(tx.get('quantity'))
        unit_price = number(tx.get('price'))
        buy_fee, sell_fee = number(tx.get('buy_fee')), number(tx.get('sell_fee'))
        tax, other_fee = number(tx.get('tax')), number(tx.get('other_fee'))
        state_key = (account, code)
        st = states.setdefault(state_key, {'account': account, 'code': code, 'name': tx.get('name') or code,
            'asset_type': tx.get('asset_type') or '基金', 'quantity': 0.0,
            'book_cost': 0.0, 'realized_pnl': 0.0, 'dividends': 0.0,
            'net_cash_invested': 0.0, 'lots': []})
        if tx.get('name'):
            st['name'] = tx['name']
        if tx.get('asset_type'):
            st['asset_type'] = tx['asset_type']
        amount = unit_price if action == '现金分红' else qty * unit_price
        if action in ('买入', '红利再投'):
            cost = amount + buy_fee + other_fee
            st['quantity'] += qty
            st['book_cost'] += cost
            st['net_cash_invested'] += cost
            if st['asset_type'] == '基金':
                st['lots'].append({'date': tx.get('date', ''), 'quantity': qty,
                                   'unit_cost': cost / qty if qty else 0.0})
        elif action == '卖出':
            if qty > st['quantity'] + 1e-8:
                raise ValueError(f"{code} 卖出数量超过卖出前持仓（可用 {st['quantity']:.4f}）")
            if st['asset_type'] == '基金':
                left, sold_cost = qty, 0.0
                while left > 1e-8 and st['lots']:
                    lot = st['lots'][0]
                    used = min(left, lot['quantity'])
                    sold_cost += used * lot['unit_cost']
                    lot['quantity'] -= used
                    left -= used
                    if lot['quantity'] <= 1e-8:
                        st['lots'].pop(0)
            else:
                avg_before = st['book_cost'] / st['quantity'] if st['quantity'] else 0.0
                sold_cost = avg_before * qty
            net = amount - sell_fee - tax - other_fee
            st['quantity'] -= qty
            st['book_cost'] -= sold_cost
            st['realized_pnl'] += net - sold_cost
            st['net_cash_invested'] -= net
        elif action == '现金分红':
            dividend = amount - other_fee
            st['dividends'] += dividend
            st['net_cash_invested'] -= dividend
    price_map = {str(p['code']): p for p in prices}
    result = []
    for (_, code), st in states.items():
        quantity = st['quantity']
        price_record = price_map.get(code, {})
        current = number(price_record.get('price'))
        market_value = quantity * current
        avg_cost = st['book_cost'] / quantity if quantity else 0.0
        unrealized = market_value - st['book_cost']
        total = unrealized + st['realized_pnl'] + st['dividends']
        break_even = max(0.0, (st['book_cost'] - st['realized_pnl'] - st['dividends']) / quantity) if quantity else 0.0
        invested = st['net_cash_invested']
        clean = {k: v for k, v in st.items() if k != 'lots'}
        result.append({**clean, 'current_price': current, 'market_value': market_value,
            'avg_cost': avg_cost, 'unrealized_pnl': unrealized, 'total_pnl': total,
            'break_even': break_even, 'return_rate': total / abs(invested) if abs(invested) > 1e-8 else 0.0,
            'status': '已清仓' if quantity <= 1e-8 else ('待填当前价' if current == 0 else ('盈利' if total >= 0 else '亏损'))})
    return result


def archive_position(conn, account, code, notes=''):
    account = str(account or '').strip() or '默认账户'
    code = str(code or '').strip()
    if not code:
        raise ValueError('持仓代码不能为空')
    transactions = all_transactions(conn)
    position = next((item for item in calculate(transactions, all_prices(conn), fund_rule_map(conn))
                     if item['account'] == account and item['code'] == code), None)
    if position is None:
        raise ValueError('没有找到需要归档的持仓')
    if abs(number(position.get('quantity'))) > 1e-8:
        raise ValueError('持仓数量不为 0，不能归档')
    archived_transactions = [item for item in transactions
                             if str(item.get('account', '')).strip() == account and str(item.get('code', '')).strip() == code]
    transaction_ids = {item['id'] for item in archived_transactions}
    archived_allocations = [item for item in all_sale_allocations(conn)
                            if item.get('sale_tx_id') in transaction_ids or item.get('buy_tx_id') in transaction_ids]
    dates = sorted(str(item.get('date', ''))[:10] for item in archived_transactions if item.get('date'))
    archive_id = str(uuid.uuid4())
    archived_at = datetime.now().isoformat(timespec='seconds')
    conn.execute('''INSERT INTO position_archives
        (id,account,code,name,asset_type,archived_at,start_date,end_date,realized_pnl,total_pnl,notes,transactions_json,allocations_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (archive_id, account, code, position.get('name', code), position.get('asset_type', '基金'), archived_at,
         dates[0] if dates else '', dates[-1] if dates else '', number(position.get('realized_pnl')),
         number(position.get('total_pnl')), str(notes or ''), json.dumps(archived_transactions, ensure_ascii=False),
         json.dumps(archived_allocations, ensure_ascii=False)))
    if transaction_ids:
        placeholders = ','.join('?' for _ in transaction_ids)
        conn.execute(f'DELETE FROM fund_sale_allocations WHERE sale_tx_id IN ({placeholders}) OR buy_tx_id IN ({placeholders})', (*transaction_ids, *transaction_ids))
        conn.execute(f'DELETE FROM transactions WHERE id IN ({placeholders})', tuple(transaction_ids))
    if position.get('asset_type') == '基金':
        conn.execute('DELETE FROM fund_rules_v2 WHERE account=? AND code=?', (account, code))
    conn.commit()
    return next(item for item in all_archives(conn) if item['id'] == archive_id)


def build_fund_lots(transactions, account, code):
    lots = []
    for tx in sorted(transactions, key=lambda x: (x.get('date', ''), x.get('id', ''))):
        if str(tx.get('code', '')).strip() != code or str(tx.get('account', '')).strip() != account or tx.get('asset_type') != '基金':
            continue
        q = number(tx.get('quantity'))
        if tx.get('action') in ('买入', '红利再投'):
            amount = q * number(tx.get('price')) + number(tx.get('buy_fee')) + number(tx.get('other_fee'))
            lots.append({'buy_tx_id': tx.get('id', ''), 'date': tx.get('date', ''), 'quantity': q, 'unit_cost': amount / q if q else 0.0})
        elif tx.get('action') == '卖出':
            left = q
            while left > 1e-8 and lots:
                used = min(left, lots[0]['quantity'])
                lots[0]['quantity'] -= used
                left -= used
                if lots[0]['quantity'] <= 1e-8:
                    lots.pop(0)
    return lots


def fee_preview(conn, transactions, payload):
    code = str(payload.get('code', '')).strip()
    account = str(payload.get('account', '')).strip() or next((str(t.get('account', '')).strip() for t in transactions if str(t.get('code', '')).strip() == code), '默认账户')
    qty = number(payload.get('quantity'))
    unit_price = number(payload.get('price'))
    operation = payload.get('operation') or ('减仓' if payload.get('action') == '卖出' else '加仓')
    asset_type = payload.get('asset_type') or next((t.get('asset_type') for t in transactions if str(t.get('code', '')).strip() == code), '基金')
    s = get_settings(conn)
    if operation not in ('加仓', '减仓'):
        return {'buy_fee': 0, 'sell_fee': 0, 'tax': 0, 'lot_preview': []}
    if qty <= 0 or unit_price < 0:
        return {'buy_fee': 0, 'sell_fee': 0, 'tax': 0, 'lot_preview': []}
    if operation == '加仓':
        if asset_type == '股票':
            fee = max(qty * unit_price * s['stock_buy_rate'], s['stock_buy_min'])
        elif asset_type == 'ETF':
            fee = max(qty * unit_price * s['etf_buy_rate'], s['etf_buy_min'])
        elif asset_type == '可转债':
            fee = max(qty * unit_price * s['convertible_buy_rate'], s['convertible_buy_min'])
        else:
            rule = fund_rule_map(conn).get((account, code), {})
            rate = number(rule.get('buy_rate', s['fund_buy_rate']))
            base = qty * unit_price
            # 交易中 quantity × price 是扣除申购费后的净申购金额；申购费按净额 × 费率计算。
            fee = base * rate
            fee = max(fee, number(rule.get('buy_min', 0)))
        return {'buy_fee': fee, 'sell_fee': 0, 'tax': 0, 'lot_preview': []}
    if asset_type != '基金':
        amount = qty * unit_price
        if asset_type == '股票':
            return {'buy_fee': 0, 'sell_fee': max(amount * s['stock_sell_rate'], s['stock_sell_min']) if amount else 0, 'tax': amount * s['stock_tax_rate'], 'lot_preview': []}
        if asset_type == '可转债':
            return {'buy_fee': 0, 'sell_fee': max(amount * s['convertible_sell_rate'], s['convertible_sell_min']) if amount else 0, 'tax': amount * s['convertible_tax_rate'], 'lot_preview': []}
        return {'buy_fee': 0, 'sell_fee': max(amount * s['etf_sell_rate'], s['etf_sell_min']) if amount else 0, 'tax': amount * s['etf_tax_rate'], 'lot_preview': []}
    rule = fund_rule_map(conn).get((account, code), {})
    fallback = number(rule.get('sell_rate', s['fund_sell_rate']))
    sale_date = payload.get('date') or date.today().isoformat()
    left, total = qty, 0.0
    preview = []
    for lot in build_fund_lots(transactions, account, code):
        if left <= 1e-8:
            break
        used = min(left, lot['quantity'])
        holding = days_between(lot['date'], sale_date)
        rate = redemption_rate(rule, holding, fallback)
        fee = used * unit_price * rate
        total += fee
        preview.append({'buy_tx_id': lot.get('buy_tx_id', ''), 'date': lot['date'], 'quantity': used, 'holding_days': holding, 'rate': rate, 'fee': fee})
        left -= used
    return {'buy_fee': 0, 'sell_fee': total, 'tax': 0, 'lot_preview': preview, 'unmatched_quantity': max(0, left)}


def _get_json(url):
    req = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://quote.eastmoney.com/'})
    with urlopen(req, timeout=8) as response:
        return json.loads(response.read().decode('utf-8', 'ignore'))


def lookup_code(code):
    raw = _get_json('https://searchapi.eastmoney.com/api/suggest/get?input=' + quote(code) + '&type=14')
    candidates = []
    for item in (raw.get('QuotationCodeTable', {}).get('Data') or []):
        classify, name = item.get('Classify', ''), item.get('Name', '')
        security_type = item.get('SecurityTypeName', '')
        is_convertible = '转债' in name or '转债' in security_type
        if classify not in ('AStock', 'Fund', 'OTCFUND') and '基金' not in security_type and not is_convertible:
            continue
        asset_type = '可转债' if is_convertible else ('股票' if classify == 'AStock' else ('ETF' if 'ETF' in name.upper() else '基金'))
        quote_id, latest, change = item.get('QuoteID', ''), 0.0, 0.0
        if asset_type in ('股票', 'ETF', '可转债') and quote_id:
            try:
                data = (_get_json('https://push2.eastmoney.com/api/qt/stock/get?secid=' + quote(quote_id) + '&fields=f43%2Cf170').get('data') or {})
                latest = number(data.get('f43')) / 1000 if data.get('f43') is not None else 0.0
                change = number(data.get('f170')) / 100 if data.get('f170') is not None else 0.0
            except Exception:
                try:
                    market = 'sh' if quote_id.startswith('1.') else 'sz'
                    req = Request('https://qt.gtimg.cn/q=' + market + item.get('Code', code), headers={'User-Agent': 'Mozilla/5.0'})
                    text = urlopen(req, timeout=8).read().decode('gbk', 'ignore')
                    # Tencent's endpoint returns a JavaScript assignment rather than JSON.
                    parts = text.split('~')
                    latest, change = number(parts[3]), number(parts[32]) / 100 if len(parts) > 32 else 0.0
                except Exception:
                    pass
        elif asset_type == '基金':
            try:
                data = (_get_json('https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx?FCODE=' + quote(item.get('Code', code)) + '&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0').get('Datas') or {})
                latest, change = number(data.get('DWJZ')), number(data.get('RZDF')) / 100
            except Exception:
                pass
        candidates.append({'code': item.get('Code') or code, 'name': name, 'asset_type': asset_type, 'exchange': item.get('SecurityTypeName') or item.get('JYS', ''), 'price': latest, 'change': change})
    if not candidates and code.isdigit() and len(code) == 6:
        data = (_get_json('https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx?FCODE=' + quote(code) + '&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0').get('Datas') or {})
        if data.get('SHORTNAME'):
            candidates.append({'code': code, 'name': data.get('SHORTNAME'), 'asset_type': '基金', 'exchange': '场外基金', 'price': number(data.get('DWJZ')), 'change': number(data.get('RZDF')) / 100})
    return {'code': code, 'candidates': candidates}


def replace_state(conn, transactions, prices, settings=None, fund_rules=None, templates=None, allocations=None, archives=None):
    conn.execute('DELETE FROM transactions'); conn.execute('DELETE FROM prices'); conn.execute('DELETE FROM fund_rules'); conn.execute('DELETE FROM fund_rules_v2'); conn.execute('DELETE FROM fund_sale_allocations'); conn.execute('DELETE FROM position_archives')
    for tx in transactions:
        tx = {**tx, 'id': tx.get('id') or str(uuid.uuid4())}
        conn.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (tx['id'], tx.get('date', ''), tx.get('account', ''), tx.get('asset_type', '基金'), tx.get('code', ''), tx.get('name', ''), tx.get('action', '买入'), number(tx.get('quantity')), number(tx.get('price')), number(tx.get('buy_fee')), number(tx.get('sell_fee')), number(tx.get('tax')), number(tx.get('other_fee')), tx.get('note', '')))
    for p in prices:
        conn.execute('INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?)', (str(p['code']), p.get('name', ''), p.get('asset_type', '基金'), number(p.get('price')), p.get('updated_at', date.today().isoformat()), p.get('pnl_override')))
    for key, value in (settings or {}).items():
        if key in DEFAULT_SETTINGS:
            conn.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', (key, number(value)))
    for rule in (fund_rules or []):
        if rule.get('account'):
            conn.execute('INSERT OR REPLACE INTO fund_rules_v2 VALUES (?,?,?,?,?,?,?,?)', (str(rule.get('account', '')).strip(), str(rule.get('code', '')).strip(), rule.get('name', ''), number(rule.get('buy_rate', 0.0015)), number(rule.get('buy_min', 0)), rule.get('buy_mode', 'external'), json.dumps(rule.get('redemption_tiers', []), ensure_ascii=False), rule.get('updated_at', date.today().isoformat())))
        else:
            conn.execute('INSERT OR REPLACE INTO fund_rules VALUES (?,?,?,?,?,?,?)', (str(rule.get('code', '')).strip(), rule.get('name', ''), number(rule.get('buy_rate', 0.0015)), number(rule.get('buy_min', 0)), rule.get('buy_mode', 'external'), json.dumps(rule.get('redemption_tiers', []), ensure_ascii=False), rule.get('updated_at', date.today().isoformat())))
    for item in (templates or []):
        conn.execute('INSERT OR REPLACE INTO fund_rule_templates VALUES (?,?,?,?)', (str(item.get('id') or uuid.uuid4()), item.get('name', ''), json.dumps(item.get('redemption_tiers', []), ensure_ascii=False), item.get('updated_at', date.today().isoformat())))
    for item in (allocations or []):
        conn.execute('INSERT OR REPLACE INTO fund_sale_allocations VALUES (?,?,?,?,?,?,?,?,?,?)', tuple(item.get(k, '') for k in ('id', 'sale_tx_id', 'buy_tx_id', 'account', 'code', 'buy_date', 'quantity', 'holding_days', 'rate', 'fee')))
    for item in (archives or []):
        conn.execute('''INSERT OR REPLACE INTO position_archives
            (id,account,code,name,asset_type,archived_at,start_date,end_date,realized_pnl,total_pnl,notes,transactions_json,allocations_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (str(item.get('id') or uuid.uuid4()), str(item.get('account', '')).strip() or '默认账户', str(item.get('code', '')).strip(),
             item.get('name', ''), item.get('asset_type', '基金'), item.get('archived_at', datetime.now().isoformat(timespec='seconds')),
             item.get('start_date', ''), item.get('end_date', ''), number(item.get('realized_pnl')), number(item.get('total_pnl')),
             item.get('notes', ''), json.dumps(item.get('transactions', []), ensure_ascii=False), json.dumps(item.get('sale_allocations', []), ensure_ascii=False)))
    conn.commit()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def cookie_token(self):
        raw = self.headers.get('Cookie', '')
        for item in raw.split(';'):
            key, _, value = item.strip().partition('=')
            if key == 'portfolio_session': return value
        return ''

    def authenticated(self):
        cleanup_sessions()
        token = self.cookie_token()
        return bool(token and token in SESSIONS and SESSIONS[token] > time.time())

    def require_auth(self):
        if self.authenticated(): return True
        self.send_json({'error': '请先登录'}, 401)
        return False

    def set_session_cookie(self, token, max_age=SESSION_TTL):
        self.send_header('Set-Cookie', f'portfolio_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}')

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads((self.rfile.read(length) if length else b'{}').decode('utf-8'))

    def do_GET(self):
        parsed, path = urlparse(self.path), urlparse(self.path).path
        if path == '/api/auth':
            conn = db(); configured = auth_user(conn) is not None; conn.close()
            self.send_json({'configured': configured, 'authenticated': self.authenticated()}); return
        if path in ('/', '/index.html'):
            conn = db(); configured = auth_user(conn) is not None; conn.close()
            if not configured:
                body = auth_page(True); self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
            if not self.authenticated():
                body = auth_page(False); self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path.startswith('/api/') and path not in ('/api/auth',):
            if not self.require_auth(): return
        if path == '/api/state':
            conn = db(); tx, prices = all_transactions(conn), all_prices(conn); settings, rules = get_settings(conn), all_fund_rules(conn); templates, allocations, archives = all_rule_templates(conn), all_sale_allocations(conn), all_archives(conn); conn.close()
            try:
                accounts = sorted({str(t.get('account', '')).strip() for t in tx if str(t.get('account', '')).strip()} | {str(item.get('account', '')).strip() for item in archives if str(item.get('account', '')).strip()})
                self.send_json({'transactions': tx, 'prices': prices, 'positions': calculate(tx, prices), 'settings': settings, 'fund_rules': rules, 'fund_rule_templates': templates, 'sale_allocations': allocations, 'archives': archives, 'accounts': accounts})
            except ValueError as exc: self.send_json({'error': str(exc)}, 400)
            return
        if path == '/api/export':
            conn = db(); self.send_json({'transactions': all_transactions(conn), 'prices': all_prices(conn), 'settings': get_settings(conn), 'fund_rules': all_fund_rules(conn), 'fund_rule_templates': all_rule_templates(conn), 'sale_allocations': all_sale_allocations(conn), 'archives': all_archives(conn)}); conn.close(); return
        if path == '/api/lookup':
            code = (parse_qs(parsed.query).get('code') or [''])[0].strip()
            if not code: self.send_json({'error': '请输入代码'}, 400); return
            try: self.send_json(lookup_code(code))
            except Exception as exc: self.send_json({'error': f'在线查询失败：{exc}'}, 502)
            return
        if path.startswith('/api/'):
            self.send_json({'error': '未找到接口'}, 404); return
        file_path = ROOT / ('index.html' if path in ('/', '') else path.lstrip('/'))
        if file_path.exists() and file_path.is_file() and ROOT in file_path.parents:
            content_type = 'text/html; charset=utf-8' if file_path.suffix == '.html' else 'text/css; charset=utf-8' if file_path.suffix == '.css' else 'application/javascript; charset=utf-8'
            body = file_path.read_bytes(); self.send_response(200); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/setup', '/api/login', '/api/logout') and not self.require_auth(): return
        try:
            payload, conn = self.read_json(), db()
            if path == '/api/setup':
                if auth_user(conn) is not None: conn.close(); self.send_json({'error': '登录账号已经设置'}, 400); return
                username = str(payload.get('username', '')).strip(); password = str(payload.get('password', ''))
                if not username: raise ValueError('登录账号不能为空')
                if len(password) < 8: raise ValueError('密码至少需要 8 位')
                save_auth_user(conn, username, password); token = secrets.token_urlsafe(32); SESSIONS[token] = time.time() + SESSION_TTL; conn.close()
                self.send_response(200); self.set_session_cookie(token); body = b'{"ok":true}'; self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
            if path == '/api/login':
                row = auth_user(conn); username = str(payload.get('username', '')).strip(); password = str(payload.get('password', ''))
                if row is None or username != row['username'] or not verify_password(row, password): conn.close(); self.send_json({'error': '账号或密码错误'}, 401); return
                token = secrets.token_urlsafe(32); SESSIONS[token] = time.time() + SESSION_TTL; conn.close()
                self.send_response(200); self.set_session_cookie(token); body = b'{"ok":true}'; self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
            if path == '/api/logout':
                token = self.cookie_token(); SESSIONS.pop(token, None); conn.close(); self.send_response(200); self.set_session_cookie('', 0); body = b'{"ok":true}'; self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
            if path == '/api/archives':
                archive = archive_position(conn, payload.get('account'), payload.get('code'), payload.get('notes', ''))
                conn.close(); self.send_json({'ok': True, 'archive': archive}); return
            if path.startswith('/api/archives/'):
                archive_id = path.rsplit('/', 1)[-1]
                if not conn.execute('SELECT 1 FROM position_archives WHERE id=?', (archive_id,)).fetchone():
                    raise ValueError('没有找到归档记录')
                conn.execute('UPDATE position_archives SET notes=? WHERE id=?', (str(payload.get('notes', '')), archive_id))
                conn.commit(); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/transactions':
                candidate = {**payload, 'id': payload.get('id') or str(uuid.uuid4()), 'asset_type': payload.get('asset_type', '基金'), 'action': payload.get('action', '买入'), 'code': str(payload.get('code', '')).strip()}
                candidate['account'] = str(candidate.get('account', '')).strip() or '默认账户'
                for key in ('quantity', 'price', 'buy_fee', 'sell_fee', 'tax', 'other_fee'): candidate[key] = number(candidate.get(key))
                allocation_preview = []
                if candidate['asset_type'] == '基金' and candidate['action'] == '卖出':
                    preview = fee_preview(conn, all_transactions(conn), {**candidate, 'operation': '减仓'})
                    allocation_preview = preview.get('lot_preview', [])
                    candidate['sell_fee'] = number(preview.get('sell_fee'))
                calculate(all_transactions(conn) + [candidate], all_prices(conn), fund_rule_map(conn))
                conn.execute('INSERT OR REPLACE INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tuple(candidate.get(k, '') for k in ('id', 'date', 'account', 'asset_type', 'code', 'name', 'action', 'quantity', 'price', 'buy_fee', 'sell_fee', 'tax', 'other_fee', 'note')))
                conn.execute('DELETE FROM fund_sale_allocations WHERE sale_tx_id=?', (candidate['id'],))
                for item in allocation_preview:
                    conn.execute('INSERT INTO fund_sale_allocations VALUES (?,?,?,?,?,?,?,?,?,?)', (str(uuid.uuid4()), candidate['id'], item.get('buy_tx_id', ''), candidate['account'], candidate['code'], item.get('date', ''), number(item.get('quantity')), int(item.get('holding_days', 0)), number(item.get('rate')), number(item.get('fee'))))
                after = next((item for item in calculate(all_transactions(conn), all_prices(conn), fund_rule_map(conn)) if item['account'] == candidate['account'] and item['code'] == candidate['code']), None)
                sold_out = candidate['action'] == '卖出' and after is not None and abs(number(after.get('quantity'))) <= 1e-8
                conn.commit(); conn.close(); self.send_json({'ok': True, 'id': candidate['id'], 'sold_out': sold_out}); return
            if path == '/api/prices':
                conn.execute('INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?)', (str(payload.get('code', '')).strip(), payload.get('name', ''), payload.get('asset_type', '基金'), number(payload.get('price')), date.today().isoformat(), payload.get('pnl_override'))); conn.commit(); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/position-snapshot':
                account = str(payload.get('account', '')).strip() or '默认账户'
                code = str(payload.get('code', '')).strip()
                quantity_value = number(payload.get('quantity'))
                unit_cost = number(payload.get('unit_cost'))
                market_value = number(payload.get('market_value'))
                existing_price = conn.execute('SELECT price FROM prices WHERE code=?', (code,)).fetchone()
                current_price = number(payload.get('current_price')) or number(existing_price['price'] if existing_price else 0) or (market_value / quantity_value if quantity_value else 0)
                if not code or quantity_value <= 0: raise ValueError('持仓代码和数量不能为空')
                if unit_cost < 0 or market_value < 0 or current_price < 0: raise ValueError('成本价、市值和现价不能为负数')
                row = conn.execute("SELECT * FROM transactions WHERE account=? AND code=? AND action='买入' AND note LIKE '手工录入当前持仓%' ORDER BY date, id LIMIT 1", (account, code)).fetchone()
                if row is None: raise ValueError('该持仓包含历史交易，不能直接改写；请通过加减仓调整')
                conn.execute('UPDATE transactions SET name=?, quantity=?, price=? WHERE id=?', (str(payload.get('name', '')).strip() or row['name'], quantity_value, unit_cost, row['id']))
                conn.execute('INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?)', (code, str(payload.get('name', '')).strip() or row['name'], payload.get('asset_type', row['asset_type']), current_price, date.today().isoformat(), None))
                calculate(all_transactions(conn), all_prices(conn), fund_rule_map(conn))
                conn.commit(); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/settings':
                for key, value in payload.items():
                    if key in DEFAULT_SETTINGS:
                        value = number(value)
                        if value < 0: raise ValueError('费率和最低费用不能为负数')
                        conn.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', (key, value))
                conn.commit(); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/fund-rules':
                code = str(payload.get('code', '')).strip()
                if not code: raise ValueError('基金代码不能为空')
                account = str(payload.get('account', '')).strip() or '默认账户'
                tiers = payload.get('redemption_tiers', [])
                if not isinstance(tiers, list): raise ValueError('赎回费率阶梯格式不正确')
                conn.execute('INSERT OR REPLACE INTO fund_rules_v2 VALUES (?,?,?,?,?,?,?,?)', (account, code, payload.get('name', ''), number(payload.get('buy_rate', 0)), number(payload.get('buy_min', 0)), payload.get('buy_mode', 'external'), json.dumps(tiers, ensure_ascii=False), date.today().isoformat())); conn.commit(); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/fund-rule-templates':
                template_id = str(payload.get('id') or uuid.uuid4())
                name = str(payload.get('name', '')).strip()
                if not name: raise ValueError('模板名称不能为空')
                tiers = payload.get('redemption_tiers', [])
                conn.execute('INSERT OR REPLACE INTO fund_rule_templates VALUES (?,?,?,?)', (template_id, name, json.dumps(tiers, ensure_ascii=False), date.today().isoformat())); conn.commit(); conn.close(); self.send_json({'ok': True, 'id': template_id}); return
            if path == '/api/fee-preview':
                result = fee_preview(conn, all_transactions(conn), payload); conn.close(); self.send_json(result); return
            if path == '/api/simulate':
                tx, prices, rules = all_transactions(conn), all_prices(conn), fund_rule_map(conn); before = calculate(tx, prices, rules); code = str(payload.get('code', '')).strip(); account = str(payload.get('account', '')).strip() or '默认账户'; current = next((p for p in before if p['code'] == code and p['account'] == account), None)
                operation, action = payload.get('operation', '加仓'), '买入' if payload.get('operation', '加仓') == '加仓' else '卖出'; sim_date = payload.get('date') or date.today().isoformat()
                draft = {'id': 'simulation', 'date': sim_date, 'account': account, 'asset_type': (current or {}).get('asset_type', payload.get('asset_type', '基金')), 'code': code, 'name': (current or {}).get('name', code), 'action': action, 'quantity': payload.get('quantity', 0), 'price': payload.get('price', 0), 'buy_fee': payload.get('buy_fee', 0), 'sell_fee': payload.get('sell_fee', 0), 'tax': payload.get('tax', 0), 'other_fee': payload.get('other_fee', 0)}
                after = calculate(tx + [draft], prices, rules); now = next((p for p in before if p['code'] == code and p['account'] == account), {'quantity': 0, 'book_cost': 0, 'avg_cost': 0, 'break_even': 0, 'realized_pnl': 0, 'dividends': 0, 'current_price': 0, 'total_pnl': 0}); later = next((p for p in after if p['code'] == code and p['account'] == account), {'quantity': 0, 'book_cost': 0, 'avg_cost': 0, 'break_even': 0, 'realized_pnl': 0, 'dividends': 0, 'current_price': now.get('current_price', 0), 'total_pnl': 0})
                q, p = number(payload.get('quantity')), number(payload.get('price')); cash_flow = -(q * p + number(payload.get('buy_fee')) + number(payload.get('other_fee'))) if action == '买入' else q * p - number(payload.get('sell_fee')) - number(payload.get('tax')) - number(payload.get('other_fee'))
                preview = fee_preview(conn, tx, {**payload, 'operation': operation, 'date': sim_date}) if operation == '减仓' else {}
                self.send_json({'before': now, 'after': later, 'cash_flow': cash_flow, 'lot_preview': preview.get('lot_preview', [])}); conn.close(); return
            if path == '/api/import-pdf-preview':
                encoded = str(payload.get('data', ''))
                if not encoded: raise ValueError('请选择 PDF 文件')
                try:
                    pdf_bytes = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError):
                    raise ValueError('PDF 文件内容无效')
                if len(pdf_bytes) > 30 * 1024 * 1024:
                    raise ValueError('PDF 文件不能超过 30MB')
                result = parse_fund_pdf(pdf_bytes)
                result['filename'] = str(payload.get('filename', '基金交易流水.pdf'))[:200]
                conn.close(); self.send_json(result); return
            if path == '/api/import-pdf':
                incoming = payload.get('transactions')
                if not isinstance(incoming, list) or not incoming:
                    raise ValueError('没有可导入的交易记录')
                incoming = sorted(incoming, key=lambda item: (str(item.get('date', ''))[:10], str(item.get('id', ''))))
                account = str(payload.get('account', '')).strip() or '默认账户'
                existing = all_transactions(conn)
                existing_keys = {(str(item.get('account', '')), str(item.get('note', '')), str(item.get('code', '')), str(item.get('action', '')), str(item.get('date', '')), number(item.get('quantity')), number(item.get('price')), number(item.get('buy_fee')), number(item.get('sell_fee'))) for item in existing if item.get('note')}
                inserted, skipped, allocations, opening_count = [], 0, [], 0
                statement_start = min((str(item.get('date', ''))[:10] for item in incoming if item.get('date')), default=date.today().isoformat())
                for item in incoming:
                    candidate = {**item, 'id': item.get('id') or str(uuid.uuid4()), 'account': account,
                                 'asset_type': '基金', 'code': str(item.get('code', '')).strip(),
                                 'name': str(item.get('name', '')).strip() or str(item.get('code', '')).strip(),
                                 'action': item.get('action') if item.get('action') in ('买入', '卖出') else '买入'}
                    candidate['quantity'] = number(candidate.get('quantity')); candidate['price'] = number(candidate.get('price'))
                    candidate['buy_fee'] = number(candidate.get('buy_fee')); candidate['sell_fee'] = number(candidate.get('sell_fee'))
                    candidate['tax'] = number(candidate.get('tax')); candidate['other_fee'] = number(candidate.get('other_fee'))
                    key = (account, str(candidate.get('note', '')), candidate['code'], candidate['action'], str(candidate.get('date', '')), candidate['quantity'], candidate['price'], candidate['buy_fee'], candidate['sell_fee'])
                    if key[0] and key in existing_keys:
                        skipped += 1; continue
                    if not candidate['code'] or candidate['quantity'] <= 0 or candidate['price'] < 0:
                        raise ValueError('导入记录缺少基金代码、份额或价格')
                    current = existing + inserted
                    if candidate['action'] == '卖出':
                        available = sum(number(lot.get('quantity')) for lot in build_fund_lots(current, account, candidate['code']))
                        missing = max(0.0, candidate['quantity'] - available)
                        if missing > 1e-8:
                            # A statement may begin after an older position was
                            # acquired. Add an explicit zero-cost opening lot so
                            # the historical sell can still be represented, and
                            # surface it as a note for later cost correction.
                            opening = {'id': str(uuid.uuid4()), 'date': statement_start, 'account': account,
                                       'asset_type': '基金', 'code': candidate['code'], 'name': candidate['name'],
                                       'action': '买入', 'quantity': missing, 'price': 0.0, 'buy_fee': 0.0,
                                       'sell_fee': 0.0, 'tax': 0.0, 'other_fee': 0.0,
                                       'note': f"PDF导入 · 期初持仓补齐（成本待核对） · {candidate['code']}"}
                            conn.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tuple(opening.get(k, '') for k in ('id', 'date', 'account', 'asset_type', 'code', 'name', 'action', 'quantity', 'price', 'buy_fee', 'sell_fee', 'tax', 'other_fee', 'note')))
                            inserted.append(opening); opening_count += 1
                            current = existing + inserted
                        try:
                            allocations.extend(imported_sale_allocations(current, candidate))
                        except ValueError:
                            # Same-day rows can be ordered differently in a PDF
                            # than in the source ledger. Keep the sell visible by
                            # adding an explicit, reviewable opening lot.
                            opening = {'id': str(uuid.uuid4()), 'date': statement_start, 'account': account,
                                       'asset_type': '基金', 'code': candidate['code'], 'name': candidate['name'],
                                       'action': '买入', 'quantity': candidate['quantity'], 'price': 0.0, 'buy_fee': 0.0,
                                       'sell_fee': 0.0, 'tax': 0.0, 'other_fee': 0.0,
                                       'note': f"PDF导入 · 期初持仓补齐（成本待核对） · {candidate['code']}"}
                            conn.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tuple(opening.get(k, '') for k in ('id', 'date', 'account', 'asset_type', 'code', 'name', 'action', 'quantity', 'price', 'buy_fee', 'sell_fee', 'tax', 'other_fee', 'note')))
                            inserted.append(opening); opening_count += 1
                            allocations.extend(imported_sale_allocations(existing + inserted, candidate))
                    conn.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tuple(candidate.get(k, '') for k in ('id', 'date', 'account', 'asset_type', 'code', 'name', 'action', 'quantity', 'price', 'buy_fee', 'sell_fee', 'tax', 'other_fee', 'note')))
                    inserted.append(candidate); existing_keys.add(key)
                # Give newly imported funds a usable common redemption rule without
                # overwriting an existing account-specific rule.
                template_row = conn.execute("SELECT redemption_tiers FROM fund_rule_templates WHERE id='common'").fetchone()
                default_tiers = template_row['redemption_tiers'] if template_row else '[]'
                for item in inserted:
                    if not conn.execute('SELECT 1 FROM fund_rules_v2 WHERE account=? AND code=?', (account, item['code'])).fetchone():
                        conn.execute('INSERT INTO fund_rules_v2 VALUES (?,?,?,?,?,?,?,?)', (account, item['code'], item['name'], 0.0, 0.0, 'external', default_tiers, date.today().isoformat()))
                for item in allocations:
                    conn.execute('INSERT INTO fund_sale_allocations VALUES (?,?,?,?,?,?,?,?,?,?)', tuple(item.get(k, '') for k in ('id', 'sale_tx_id', 'buy_tx_id', 'account', 'code', 'buy_date', 'quantity', 'holding_days', 'rate', 'fee')))
                # Validate the entire resulting ledger before committing.
                calculate(all_transactions(conn), all_prices(conn), fund_rule_map(conn))
                conversion_ids = {match.group(1) for item in inserted for match in [re.search(r'跨TA转换 (\d{8}-\d{8})', item.get('note', ''))] if match}
                conn.commit(); conn.close(); self.send_json({'ok': True, 'inserted': len(inserted), 'skipped': skipped, 'opening_count': opening_count, 'conversion_count': len(conversion_ids)}); return
            if path == '/api/import':
                replace_state(conn, payload.get('transactions', []), payload.get('prices', []), payload.get('settings'), payload.get('fund_rules'), payload.get('fund_rule_templates'), payload.get('sale_allocations'), payload.get('archives')); conn.close(); self.send_json({'ok': True}); return
            conn.close(); self.send_json({'error': '未找到接口'}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as exc: self.send_json({'error': str(exc)}, 400)

    def do_DELETE(self):
        if not self.require_auth(): return
        path = urlparse(self.path).path
        try:
            if path == '/api/positions':
                payload, conn = self.read_json(), db()
                items = payload.get('items')
                if not isinstance(items, list) or not items: raise ValueError('请选择要删除的持仓')
                targets = {(str(item.get('account', '')).strip() or '默认账户', str(item.get('code', '')).strip()) for item in items if isinstance(item, dict) and str(item.get('code', '')).strip()}
                deleted = 0
                for account, code in targets:
                    if not conn.execute('SELECT 1 FROM transactions WHERE account=? AND code=? LIMIT 1', (account, code)).fetchone(): continue
                    conn.execute('''DELETE FROM fund_sale_allocations
                        WHERE sale_tx_id IN (SELECT id FROM transactions WHERE account=? AND code=?)
                           OR buy_tx_id IN (SELECT id FROM transactions WHERE account=? AND code=?)''', (account, code, account, code))
                    conn.execute('DELETE FROM transactions WHERE account=? AND code=?', (account, code))
                    conn.execute('DELETE FROM fund_rules_v2 WHERE account=? AND code=?', (account, code))
                    if not conn.execute('SELECT 1 FROM transactions WHERE code=? LIMIT 1', (code,)).fetchone():
                        conn.execute('DELETE FROM prices WHERE code=?', (code,))
                    deleted += 1
                conn.commit(); conn.close(); self.send_json({'ok': True, 'deleted': deleted}); return
            if path == '/api/archives':
                payload, conn = self.read_json(), db()
                raw_ids = payload.get('ids')
                if not isinstance(raw_ids, list): raise ValueError('请选择要删除的归档')
                ids = list(dict.fromkeys(str(item).strip() for item in raw_ids if str(item).strip()))
                if not ids: raise ValueError('请选择要删除的归档')
                placeholders = ','.join('?' for _ in ids)
                deleted = conn.execute(f'DELETE FROM position_archives WHERE id IN ({placeholders})', ids).rowcount
                conn.commit(); conn.close(); self.send_json({'ok': True, 'deleted': deleted}); return
            if path.startswith('/api/transactions/'):
                tx_id = path.rsplit('/', 1)[-1]
                conn = db(); conn.execute('DELETE FROM transactions WHERE id=?', (tx_id,)); conn.execute('DELETE FROM fund_sale_allocations WHERE sale_tx_id=? OR buy_tx_id=?', (tx_id, tx_id)); conn.commit(); conn.close(); self.send_json({'ok': True}); return
            self.send_json({'error': '未找到接口'}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self.send_json({'error': str(exc)}, 400)


def main():
    host, port = os.environ.get('PORTFOLIO_HOST', '0.0.0.0'), int(os.environ.get('PORTFOLIO_PORT', '8080'))
    print(f'Portfolio tracker listening on http://{host}:{port}; database={DB_PATH}')
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__': main()
