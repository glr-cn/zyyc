#!/bin/sh
# ============================================================================
#  启动前：如果持久目录的 erp.db 是空库（自愈会扫不到任何备份），
#  主动把包里带的本地备份（data/erp.restore-from-local.db）注入持久目录，
#  让 src/db/index.js 的 trySelfHeal() 能扫到候选并自动恢复。
#  这样 logger 修复后首次启动就能把线上空库恢复成有业务数据的状态。
# ============================================================================
cd "$(dirname "$0")"

PERSIST_DIR="${HOME}/.wbapp-erp-data"
PERSIST_DB="${PERSIST_DIR}/erp.db"
BUNDLE_BACKUP="./data/erp.restore-from-local.db"

# 先确保持久目录存在（run.sh 比 Node 早跑，此时 fs.mkdirSync 还没机会创建）
mkdir -p "$PERSIST_DIR"

if [ -f "$BUNDLE_BACKUP" ]; then
  # 持久目录存在，但 erp.db 可能还没被创建（首次启动）
  if [ ! -f "$PERSIST_DB" ]; then
    # 还没生成过持久库：直接把备份放进去，跳过后续自愈也能用
    cp "$BUNDLE_BACKUP" "$PERSIST_DB"
    echo "[restore] 持久目录初始化为包内备份（之前从未启动成功过）"
  else
    # 已经有持久库：判断是否为空库
    EMPTY=$(node -e "
      const { openDatabase } = require('./src/db/driver');
      let db;
      try { db = openDatabase('$PERSIST_DB', { readOnly: true, fileMustExist: true }); }
      catch (e) { console.log('YES'); process.exit(0); }
      const tables = new Set(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name));
      const biz = ['customers','orders','inventory_transactions','work_hours','logistics_quotes','smart_quote_batches','smart_quote_records'];
      let total = 0;
      for (const t of biz) if (tables.has(t)) try { total += db.prepare('SELECT COUNT(*) c FROM ' + JSON.stringify(t)).get().c; } catch (e) {}
      db.close();
      console.log(total === 0 ? 'YES' : 'NO');
    " 2>/dev/null || echo "UNKNOWN")
    if [ "$EMPTY" = "YES" ]; then
      cp "$BUNDLE_BACKUP" "$PERSIST_DB"
      echo "[restore] 检测到持久库为空，已用包内备份覆盖（业务数据已注入）"
    else
      echo "[restore] 持久库已有业务数据（判断=$EMPTY），跳过注入"
    fi
  fi
else
  echo "[restore] 持久目录或包内备份缺失（dir=$([ -d "$PERSIST_DIR" ] && echo ok || echo miss), backup=$([ -f "$BUNDLE_BACKUP" ] && echo ok || echo miss)），跳过注入"
fi

exec node src/server.js
