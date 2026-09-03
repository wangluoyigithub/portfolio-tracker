#!/usr/bin/env python3
import json
import os
import sqlite3
import uuid
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get('PORTFOLIO_DB', ROOT / 'data' / 'portfolio.db'))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

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
        price REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)''')
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
    price_map = {str(p['code']): number(p.get('price')) for p in prices}
    result = []
    for (_, code), st in states.items():
        quantity = st['quantity']
        current = price_map.get(code, 0.0)
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


def demo_transactions():
    return [
        {'id': str(uuid.uuid4()), 'date': '2026-01-10', 'account': '基金账户1', 'asset_type': '基金', 'code': '000300', 'name': '沪深300示例基金', 'action': '买入', 'quantity': 1000, 'price': 1.0, 'buy_fee': 5, 'sell_fee': 0, 'tax': 0, 'other_fee': 0, 'note': '示例数据，可删除'},
        {'id': str(uuid.uuid4()), 'date': '2026-02-10', 'account': '基金账户1', 'asset_type': '基金', 'code': '000300', 'name': '沪深300示例基金', 'action': '买入', 'quantity': 500, 'price': 1.05, 'buy_fee': 2.6, 'sell_fee': 0, 'tax': 0, 'other_fee': 0, 'note': '示例数据，可删除'},
        {'id': str(uuid.uuid4()), 'date': '2026-03-05', 'account': '基金账户1', 'asset_type': '基金', 'code': '000300', 'name': '沪深300示例基金', 'action': '现金分红', 'quantity': 0, 'price': 12, 'buy_fee': 0, 'sell_fee': 0, 'tax': 0, 'other_fee': 0, 'note': '示例数据，可删除'},
        {'id': str(uuid.uuid4()), 'date': '2026-03-18', 'account': '股票账户1', 'asset_type': '股票', 'code': '600519', 'name': '贵州茅台示例', 'action': '买入', 'quantity': 100, 'price': 1500, 'buy_fee': 5, 'sell_fee': 0, 'tax': 0, 'other_fee': 0, 'note': '示例数据，可删除'},
        {'id': str(uuid.uuid4()), 'date': '2026-04-10', 'account': '股票账户1', 'asset_type': '股票', 'code': '600519', 'name': '贵州茅台示例', 'action': '卖出', 'quantity': 20, 'price': 1600, 'buy_fee': 0, 'sell_fee': 5, 'tax': 32, 'other_fee': 0, 'note': '示例数据，可删除'},
    ]


def demo_prices():
    stamp = date.today().isoformat()
    return [{'code': '000300', 'name': '沪深300示例基金', 'asset_type': '基金', 'price': 1.12, 'updated_at': stamp}, {'code': '600519', 'name': '贵州茅台示例', 'asset_type': '股票', 'price': 1580, 'updated_at': stamp}]


def replace_state(conn, transactions, prices, settings=None, fund_rules=None, templates=None, allocations=None):
    conn.execute('DELETE FROM transactions'); conn.execute('DELETE FROM prices'); conn.execute('DELETE FROM fund_rules'); conn.execute('DELETE FROM fund_rules_v2'); conn.execute('DELETE FROM fund_sale_allocations')
    for tx in transactions:
        tx = {**tx, 'id': tx.get('id') or str(uuid.uuid4())}
        conn.execute('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (tx['id'], tx.get('date', ''), tx.get('account', ''), tx.get('asset_type', '基金'), tx.get('code', ''), tx.get('name', ''), tx.get('action', '买入'), number(tx.get('quantity')), number(tx.get('price')), number(tx.get('buy_fee')), number(tx.get('sell_fee')), number(tx.get('tax')), number(tx.get('other_fee')), tx.get('note', '')))
    for p in prices:
        conn.execute('INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?)', (str(p['code']), p.get('name', ''), p.get('asset_type', '基金'), number(p.get('price')), p.get('updated_at', date.today().isoformat())))
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
    conn.commit()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads((self.rfile.read(length) if length else b'{}').decode('utf-8'))

    def do_GET(self):
        parsed, path = urlparse(self.path), urlparse(self.path).path
        if path == '/api/state':
            conn = db(); tx, prices = all_transactions(conn), all_prices(conn); settings, rules = get_settings(conn), all_fund_rules(conn); templates, allocations = all_rule_templates(conn), all_sale_allocations(conn); conn.close()
            try:
                accounts = sorted({str(t.get('account', '')).strip() for t in tx if str(t.get('account', '')).strip()})
                self.send_json({'transactions': tx, 'prices': prices, 'positions': calculate(tx, prices), 'settings': settings, 'fund_rules': rules, 'fund_rule_templates': templates, 'sale_allocations': allocations, 'accounts': accounts})
            except ValueError as exc: self.send_json({'error': str(exc)}, 400)
            return
        if path == '/api/export':
            conn = db(); self.send_json({'transactions': all_transactions(conn), 'prices': all_prices(conn), 'settings': get_settings(conn), 'fund_rules': all_fund_rules(conn), 'fund_rule_templates': all_rule_templates(conn), 'sale_allocations': all_sale_allocations(conn)}); conn.close(); return
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
        try:
            payload, conn = self.read_json(), db()
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
                conn.commit(); conn.close(); self.send_json({'ok': True, 'id': candidate['id']}); return
            if path == '/api/prices':
                conn.execute('INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?)', (str(payload.get('code', '')).strip(), payload.get('name', ''), payload.get('asset_type', '基金'), number(payload.get('price')), date.today().isoformat())); conn.commit(); conn.close(); self.send_json({'ok': True}); return
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
            if path == '/api/reset-demo':
                replace_state(conn, demo_transactions(), demo_prices()); conn.close(); self.send_json({'ok': True}); return
            if path == '/api/import':
                replace_state(conn, payload.get('transactions', []), payload.get('prices', []), payload.get('settings'), payload.get('fund_rules'), payload.get('fund_rule_templates'), payload.get('sale_allocations')); conn.close(); self.send_json({'ok': True}); return
            conn.close(); self.send_json({'error': '未找到接口'}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as exc: self.send_json({'error': str(exc)}, 400)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/transactions/'):
            tx_id = path.rsplit('/', 1)[-1]
            conn = db(); conn.execute('DELETE FROM transactions WHERE id=?', (tx_id,)); conn.execute('DELETE FROM fund_sale_allocations WHERE sale_tx_id=? OR buy_tx_id=?', (tx_id, tx_id)); conn.commit(); conn.close(); self.send_json({'ok': True}); return
        self.send_json({'error': '未找到接口'}, 404)


def main():
    host, port = os.environ.get('PORTFOLIO_HOST', '0.0.0.0'), int(os.environ.get('PORTFOLIO_PORT', '8080'))
    print(f'Portfolio tracker listening on http://{host}:{port}; database={DB_PATH}')
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__': main()
