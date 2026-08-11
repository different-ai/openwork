/**
 * OpenWork 简体中文 —— 自检修复清单（第 2 轮）
 * ------------------------------------------------------------
 * 2026-08-06 对已安装 bundle 自检发现的遗留未翻译项，共 47 键：
 *   A. 10 个缺失键（en 有、zh 无 → 界面回退英文）
 *   B. 4 个 du 共享基础键（automations.*，zh 无覆盖）
 *   C. 33 个 zh 已有但值为英文的键（遗漏翻译，需覆盖）
 * 另有 22 个"值=英文"项为品牌名/技术术语/输入占位符，有意保留英文。
 *
 * 用法：由 apply-zh-patch.mjs 读取。
 *   - 键已存在于 zh 对象 → 替换为新值
 *   - 键不存在 → 插入 zh 对象
 */
export default {
  // ---- A. 缺失键（10）----
  "connect.diagnostics_safety_mutation": "未请求直接修改配置",
  "connect.manage_in_den_web": "在 Den 网页中管理",
  "connect.row_chip_ready": "就绪",
  "connect.verifying_body": "在做出任何更改前，先检查组织与服务器。",
  "connect.error_title": "此链接无法使用",
  "mcp.toggle_failed": "更新 MCP 启用状态失败。",
  "join_org.connecting_button": "正在连接…",
  "join_org.openwork_cloud": "OpenWork Cloud",
  "models.retry_organization_models": "重试",
  "settings.restart_succeeded_template": "已重启{service}。",
  // ---- B. du 共享基础键（4）----
  "automations.preferences_title": "自动化",
  "automations.preferences_section_desc": "预览由 Den 调度并由本桌面执行的重复性工作。",
  "automations.preferences_toggle": "自动化（预览）",
  "automations.preferences_toggle_desc": "在应用中显示自动化。Den 负责维护计划，本登录桌面会执行符合条件的运行。",
  // ---- C. 覆盖修复（33）----
  "composer.skill_source": "技能",
  "context_panel.always_available": "工作区根文件夹无法移除",
  "session.permission_detail_agent": "智能体",
  "settings.server_endpoints_api": "API 端点",
  "settings.server_endpoints_bootstrap_hint": "引导文件：{path}",
  "settings.server_endpoints_cloud_mcp": "Cloud 智能体 (MCP)",
  "settings.server_endpoints_desc": "只读查看应用本地覆盖与引导文件后 OpenWork 将使用的 URL。",
  "settings.server_endpoints_local_dev": "本地开发服务器",
  "settings.server_endpoints_mismatch": "与 API 端点不匹配",
  "settings.server_endpoints_not_configured": "未配置 openwork-cloud MCP 条目",
  "settings.server_endpoints_org": "组织服务器",
  "settings.server_endpoints_source_bootstrap": "来自引导文件",
  "settings.server_endpoints_source_custom": "自定义",
  "settings.server_endpoints_source_default": "默认",
  "settings.server_endpoints_title": "服务器端点",
  "settings.tab_cloud_account": "账户",
  "settings.tab_cloud_providers": "Cloud 提供商",
  "settings.tab_description_cloud_account": "登录、管理你的组织并配置你的 Cloud 连接。",
  "settings.tab_description_cloud_marketplaces": "浏览并导入你组织应用市场中的插件。",
  "settings.runtime_config_ownership_title": "运行时配置所有权",
  "settings.runtime_config_one_writer_rule": "OpenWork 只写入受管理的运行时配置文件；用户的 OpenCode 配置仍归用户所有。",
  "settings.runtime_config_managed_file_path": "受管文件：{path}",
  "settings.runtime_config_last_rebuilt": "上次重建：{time}",
  "settings.runtime_config_missing": "缺失",
  "settings.runtime_config_redacted_content": "已脱敏的受管文件",
  "settings.runtime_config_content_unavailable": "受管理的运行时配置内容不可用。",
  "settings.runtime_config_legacy_cleanup_title": "旧版清理",
  "settings.runtime_config_cleanup_pending": "等待清理。",
  "settings.runtime_config_cleanup_no_files": "未找到旧版 OpenCode 配置文件。",
  "settings.runtime_config_removed_keys": "已移除：{keys}",
  "settings.runtime_config_no_removed_keys": "未移除任何由 OpenWork 管理的键。",
  "settings.runtime_config_backup_path": "备份：{path}",
  "settings.runtime_config_no_backup": "无需备份。",
};
