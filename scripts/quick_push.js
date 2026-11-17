const { execSync } = require('child_process');
const cwd = 'd:\\数据中心网站\\light-erp';
execSync('git add -A', { cwd, stdio: 'inherit' });
execSync(
  'git commit -m "fix: 发货Tab隐藏新增按钮 + 提交冲突改成行内错误提示替代alert弹窗"',
  { cwd, stdio: 'inherit' }
);
execSync('git push origin HEAD:main', { cwd, stdio: 'inherit' });
