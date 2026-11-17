// ============================================================================
//  进程内备份调度（用于没有 cron 的托管环境，如 WorkBuddy）
// ----------------------------------------------------------------------------
//  策略：启动 1 分钟后自检一次；此后每 ERP_BACKUP_EVERY_HOURS（默认 6）小时检查，
//        若最新快照已超过 ERP_BACKUP_MAX_AGE_HOURS（默认 23）小时，就生成新快照。
//        这样即使实例频繁重启，也不会重复备份，也不会漏掉当天的备份。
//
//  环境变量：
//    ERP_BACKUP_ENABLED=0        关闭（默认开启）
//    ERP_BACKUP_DIR              快照目录（默认：库文件同级 backups/）
//    ERP_BACKUP_KEEP             保留份数（默认 30）
//    ERP_BACKUP_MAX_AGE_HOURS    超过多少小时算「需要备份」（默认 23）
//    ERP_BACKUP_EVERY_HOURS      检查间隔（默认 6）
// ============================================================================
const path = require('path');
const { runBackup, listSnapshots } = require('./dbBackup');

let started = false;
let running = false;

function startBackupScheduler(dbFile) {
  if (started) return;
  if (process.env.ERP_BACKUP_ENABLED === '0') {
    console.log('[backup] 已禁用（ERP_BACKUP_ENABLED=0）');
    return;
  }
  if (!dbFile) {
    console.warn('[backup] 未提供数据库路径，定时备份未启动');
    return;
  }
  started = true;

  const dir = process.env.ERP_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
  const keep = Number(process.env.ERP_BACKUP_KEEP) || 30;
  const maxAgeH = Number(process.env.ERP_BACKUP_MAX_AGE_HOURS) || 23;
  const everyH = Number(process.env.ERP_BACKUP_EVERY_HOURS) || 6;
  const initialDelay = Number(process.env.ERP_BACKUP_INITIAL_DELAY_MS) || 60000;

  const check = () => {
    if (running) return;
    try {
      const newest = listSnapshots(dir)[0];
      const ageH = newest ? (Date.now() - newest.mtimeMs) / 3600000 : Infinity;
      if (ageH < maxAgeH) return;
      running = true;
      const r = runBackup({ dbFile, dir, keep });
      console.log('[backup] 快照完成 ' + r.file + ' (' + r.sizeMB + 'MB, 保留 ' + r.kept + ' 份)');
    } catch (e) {
      console.error('[backup] 快照失败：' + e.message);
    } finally {
      running = false;
    }
  };

  setTimeout(check, initialDelay).unref();
  setInterval(check, everyH * 3600 * 1000).unref();
  console.log('[backup] 定时备份已启动：每 ' + everyH + 'h 检查，超过 ' + maxAgeH + 'h 未备份则生成快照 → ' + dir);
}

module.exports = { startBackupScheduler };
