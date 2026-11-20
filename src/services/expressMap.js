// ============================================================================
// expressMap.js · 快递公司编码 ↔ 名称映射服务（2026-11-20 新增）
// ----------------------------------------------------------------------------
// 存储：app_settings 表 key='express_map'，value 为 JSON 数组 [{code,name}]
// 默认：STO 申通快递 / ZTO 中通快递 / YTO4 圆通快递4 / YTO5 圆通快递5
//       SF 顺丰 / DBKD 德邦快递
// 实时生效：不做模块级缓存，每次请求从库读取（配置保存后立即对导入/统计生效）
// 未知编码策略：导入时不拦截，原样保留（避免因配置未覆盖导致导入失败）
// ============================================================================

const SETTINGS_KEY = 'express_map';

const DEFAULT_EXPRESS_MAP = [
  { code: 'STO',  name: '申通快递' },
  { code: 'ZTO',  name: '中通快递' },
  { code: 'YTO4', name: '圆通快递4' },
  { code: 'YTO5', name: '圆通快递5' },
  { code: 'SF',   name: '顺丰' },
  { code: 'DBKD', name: '德邦快递' },
];

const MAX_ITEMS = 200;
const MAX_NAME_LEN = 40;
const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;

function normalizeCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

function parseValue(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

function readMap(db) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY);
    const arr = row ? parseValue(row.value) : null;
    if (arr && arr.length) {
      return arr
        .map((x) => ({ code: normalizeCode(x && x.code), name: String((x && x.name) || '').trim() }))
        .filter((x) => x.code && x.name);
    }
  } catch (e) { /* 表不存在等异常 → 回退默认值 */ }
  return null;
}

function writeMap(db, items) {
  const value = JSON.stringify(items);
  const exists = db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(SETTINGS_KEY);
  if (exists) {
    db.prepare("UPDATE app_settings SET value=?, updated_at=datetime('now','localtime') WHERE key=?")
      .run(value, SETTINGS_KEY);
  } else {
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?)').run(SETTINGS_KEY, value);
  }
}

// 读取映射；库内无配置时自动写入默认值（首次访问即完成初始化）
function getItems(db) {
  const existing = readMap(db);
  if (existing) return existing;
  const defaults = DEFAULT_EXPRESS_MAP.map((x) => ({ ...x }));
  try { writeMap(db, defaults); } catch (e) { /* 无 app_settings 表时仅返回默认值 */ }
  return defaults;
}

function validateItem({ code, name }, items, ignoreCode) {
  const c = normalizeCode(code);
  const n = String(name == null ? '' : name).trim();
  if (!c) throw new Error('快递公司编码不能为空');
  if (!CODE_RE.test(c)) throw new Error('编码只能包含字母、数字、下划线、短横线，长度 1-20');
  if (!n) throw new Error('快递公司名称不能为空');
  if (n.length > MAX_NAME_LEN) throw new Error(`名称不能超过 ${MAX_NAME_LEN} 个字符`);
  const dupCode = items.some((x) => normalizeCode(x.code) === c && normalizeCode(x.code) !== normalizeCode(ignoreCode));
  if (dupCode) throw new Error('编码已存在：' + c);
  const dupName = items.some((x) => x.name === n && normalizeCode(x.code) !== normalizeCode(ignoreCode));
  if (dupName) throw new Error('名称已存在：' + n);
  return { code: c, name: n };
}

function addItem(db, payload) {
  const items = getItems(db);
  if (items.length >= MAX_ITEMS) throw new Error(`最多只能配置 ${MAX_ITEMS} 条映射`);
  const item = validateItem(payload || {}, items, null);
  items.push(item);
  writeMap(db, items);
  return items;
}

function updateItem(db, originalCode, payload) {
  const items = getItems(db);
  const key = normalizeCode(originalCode);
  const idx = items.findIndex((x) => normalizeCode(x.code) === key);
  if (idx < 0) throw new Error('映射不存在：' + originalCode);
  const item = validateItem(payload || {}, items, key);
  items[idx] = item;
  writeMap(db, items);
  return items;
}

function removeItem(db, code) {
  const items = getItems(db);
  const key = normalizeCode(code);
  const next = items.filter((x) => normalizeCode(x.code) !== key);
  if (next.length === items.length) throw new Error('映射不存在：' + code);
  writeMap(db, next);
  return next;
}

function resetDefaults(db) {
  const items = DEFAULT_EXPRESS_MAP.map((x) => ({ ...x }));
  writeMap(db, items);
  return items;
}

// 构建「原值 → 展示名」解析器（一次读取，供批量导入循环内复用）
// 命中规则：编码（忽略大小写）→ 名称原样 → 未知原样返回
function createResolver(db) {
  const items = getItems(db);
  const byCode = new Map();
  const names = new Set();
  for (const it of items) {
    byCode.set(normalizeCode(it.code), it.name);
    names.add(it.name);
  }
  return function resolve(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const hit = byCode.get(normalizeCode(s));
    if (hit) return hit;
    if (names.has(s)) return s;
    return s;
  };
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_EXPRESS_MAP,
  normalizeCode,
  getItems,
  addItem,
  updateItem,
  removeItem,
  resetDefaults,
  createResolver,
};
