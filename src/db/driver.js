// ============================================================================
//  统一 SQLite 驱动适配层（兼容 Node 20 与 Node 22+）
// ----------------------------------------------------------------------------
//  背景：本地开发用 Node 22+ 内置 node:sqlite（零依赖）；部署运行时是 Node 20，
//  没有该内置模块（ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite），
//  故自动退到 node-sqlite3-wasm（纯 WASM，无需本地编译，跨平台一致）。
//
//  上层只依赖本文件导出的 openDatabase()，接口与 DatabaseSync 等价：
//    db.exec(sql)
//    db.prepare(sql).get(...) / .all(...) / .run(...)
//    db.close()
//
//  选型：默认自动探测；可用 ERP_SQLITE_DRIVER=native|wasm 强制指定（测试/排障）。
//  注意：wasm 版每个连接是独立实例（文件级持久化），同一进程内请复用同一连接，
//        不要再对同一库文件另开连接，否则读取不到对方的写入。
// ============================================================================

const ROWID = Symbol('driverName');

// 内置驱动是否可用（Node 22+ 才有 node:sqlite）
function nativeAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeRun(ret) {
  return {
    changes: Number(ret && ret.changes) || 0,
    lastInsertRowid: typeof (ret && ret.lastInsertRowid) === 'bigint'
      ? Number(ret.lastInsertRowid)
      : Number((ret && ret.lastInsertRowid) || 0),
  };
}

// node:sqlite：保持原生 Statement（可复用、性能最好）
function wrapNative(conn) {
  return {
    driver: 'native',
    exec: (sql) => conn.exec(sql),
    prepare: (sql) => {
      const stmt = conn.prepare(sql);
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => normalizeRun(stmt.run(...args)),
      };
    },
    close: () => conn.close(),
    [ROWID]: conn,
  };
}

// wasm 版参数必须是「单个值 / 数组 / 命名对象」，不能像原生那样展开传参
function wasmBind(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
}

// node-sqlite3-wasm：用 Database 的便捷方法（内部自动 prepare/finalize，避免语句泄漏）
function wrapWasm(conn) {
  return {
    driver: 'wasm',
    exec: (sql) => conn.exec(sql),
    prepare: (sql) => ({
      get: (...args) => {
        const row = conn.get(sql, wasmBind(args));
        return row === null ? undefined : row; // 与原生「无行返回 undefined」保持一致
      },
      all: (...args) => conn.all(sql, wasmBind(args)),
      run: (...args) => normalizeRun(conn.run(sql, wasmBind(args))),
    }),
    close: () => conn.close(),
    [ROWID]: conn,
  };
}

/**
 * 打开数据库连接。
 * @param {string} file 库文件路径
 * @param {{readOnly?:boolean, fileMustExist?:boolean}} [options]
 */
function openDatabase(file, options) {
  const forced = String(process.env.ERP_SQLITE_DRIVER || '').toLowerCase();
  const opts = options || {};

  if (forced !== 'wasm' && nativeAvailable()) {
    const { DatabaseSync } = require('node:sqlite');
    return wrapNative(new DatabaseSync(file, opts));
  }
  if (forced === 'native') {
    throw new Error('ERP_SQLITE_DRIVER=native，但当前 Node 运行时没有 node:sqlite（需 Node 22+）');
  }
  const { Database } = require('node-sqlite3-wasm');
  return wrapWasm(new Database(file, opts));
}

module.exports = { openDatabase, nativeAvailable };
