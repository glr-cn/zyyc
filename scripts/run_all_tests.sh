#!/usr/bin/env bash
# ============================================================================
#  全量回归批处理（发布前必跑）
#  用法：bash scripts/run_all_tests.sh
#  说明：每个测试脚本独立进程运行；任何一项失败即整体失败。
#        全部使用隔离临时库，绝不触碰 data/erp.db。
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS=(
  scripts/test_db_path.js
  scripts/test_prepublish.js
  scripts/test_customer_import.js
  scripts/test_customer_link.js
  scripts/test_customers_ui.js
  scripts/test_logi.js
  scripts/test_logi_import.js
  scripts/test_smart_quote.js
  scripts/test_smart_enh.js
  scripts/test_sq_district.js
  scripts/test_sq_buttons.js
  scripts/test_menu_boot.js
  scripts/test_menu.js
  scripts/test_workhours_inline.js
  scripts/test_workhours_inline2.js
  scripts/test_workhours_inline3.js
  scripts/test_workhours_import.js
  scripts/test_workhours_archive.js
  scripts/test_workhours_archive_ui.js
  scripts/test_workhours_del_admin.js
  scripts/test_workhours_tabs.js
  scripts/test_wh.js
  scripts/test_permission_tree.js
  scripts/test_audit_logs.js
  scripts/test_log_center_api.js
  scripts/test_tabs.js
  scripts/test_pages.js
  scripts/test_layout.js
  scripts/test_brand.js
  scripts/test_export.js
  scripts/test_modal_overlay.js
  scripts/test_view_edit.js
  scripts/test_date_range_picker.js
  scripts/test_date_range_picker_ui.js
  scripts/test_xls_sticky.js
  scripts/verify_recovery_templates.js
  scripts/recovery_drill.js
)

PASS=0
FAIL=0
FAILED_LIST=""

for t in "${TESTS[@]}"; do
  [ -f "$t" ] || { echo "⚠️  跳过（不存在）：$t"; continue; }
  name=$(basename "$t" .js)
  out=$(node "$t" 2>&1)
  code=$?
  # 统计该项自身的断言结果
  np=$(printf '%s' "$out" | grep -cE '^\s*✅' )
  nf=$(printf '%s' "$out" | grep -cE '^\s*❌' )
  if [ $code -eq 0 ]; then
    printf '✅ %-34s 通过 %s 项\n' "$name" "$np"
    PASS=$((PASS+1))
  else
    printf '❌ %-34s 失败 %s 项\n' "$name" "$nf"
    printf '%s\n' "$out" | grep -E '^\s*❌|Error|错误' | head -6 | sed 's/^/      /'
    FAIL=$((FAIL+1))
    FAILED_LIST="$FAILED_LIST $name"
  fi
done

echo ""
echo "══════════════════════════════════════"
echo "通过脚本 $PASS 个，失败 $FAIL 个"
[ -n "$FAILED_LIST" ] && echo "失败项：$FAILED_LIST"
echo "══════════════════════════════════════"
[ $FAIL -eq 0 ] || exit 1
