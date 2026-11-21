// 输入校验封装：express-validator 统一错误处理
// ──────────────────────────────────────────────────────────
// 用法示例（在路由里）：
//   const { validate, rules } = require('../middleware/validate');
//   router.post('/login', rules.login, validate(400), authHandler);
// ──────────────────────────────────────────────────────────
const { validationResult, body, param, query } = require('express-validator');

/**
 * 校验结果中间件：如果有校验错误 → 返回 4xx + 错误详情 JSON
 * @param {number} statusCode 校验失败时的 HTTP 状态码，默认 400
 */
function validate(statusCode = 400) {
  return (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(statusCode).json({
        error: '输入参数校验失败',
        details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
      });
    }
    next();
  };
}

/**
 * 预定义的校验规则集合（覆盖 ERP 最常用的输入场景）
 */
const rules = {
  // ── 认证相关 ──
  login: [
    body('username').trim().notEmpty().withMessage('账号不能为空')
      .isLength({ min: 2, max: 32 }).withMessage('账号长度 2-32 字符')
      // 方案A：允许中文等 Unicode 字母/数字账号，与「新增用户不限制账号格式」的现状对齐
      .matches(/^[\p{L}\p{N}_\-\.]+$/u).withMessage('账号只能包含字母（含中文）、数字、下划线、短横线、点号'),
    body('password').notEmpty().withMessage('密码不能为空')
      .isLength({ min: 6, max: 128 }).withMessage('密码长度 6-128 字符'),
  ],

  // ── 业务 ID ──
  idParam: [
    param('id').isInt({ min: 1 }).withMessage('ID 必须是正整数'),
  ],
  idQuery: [
    query('id').optional().isInt({ min: 1 }).withMessage('ID 必须是正整数'),
  ],

  // ── 分页 ──
  pagination: [
    query('page').optional().isInt({ min: 1 }).withMessage('page 必须 ≥ 1'),
    query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('limit 必须 1-500'),
  ],

  // ── 工时 ──
  workhourCreate: [
    body('work_type').isIn(['发货', '收货', '库内', '后勤']).withMessage('工时类型非法'),
    body('warehouse').trim().notEmpty().isLength({ max: 32 }).withMessage('仓库名称过长'),
    body('work_id').optional({ nullable: true }).isInt({ min: 0 }).withMessage('work_id 必须是非负整数'),
  ],

  // ── 客户 ──
  customerSearch: [
    query('q').optional().trim().isLength({ max: 100 }).withMessage('搜索关键词过长'),
    query('warehouse').optional().trim().isLength({ max: 32 }).withMessage('仓库名称过长'),
  ],
};

module.exports = { validate, rules, body, param, query };
