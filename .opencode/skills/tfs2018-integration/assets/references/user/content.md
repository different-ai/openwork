# 公司项目快速查询指南

## 卫宁健康项目快速查询

### 常用项目快捷命令

```bash
# 门诊医生站 (WiNEX-Outpatient)
node tfs-query.mjs my-tasks "WiNEX-Outpatient"

# 住院大临床 (WiNEX-Inpatient)
node tfs-query.mjs my-tasks "WiNEX-Inpatient"

# 集成组 (WiNEX-Integration) - FHIR对接、主数据对接
node tfs-query.mjs my-tasks "WiNEX-Integration"

# 数据中台 (WiNEX-DCP)
node tfs-query.mjs my-tasks "WiNEX-DCP"

# 急诊 (WiNEX-Emergency)
node tfs-query.mjs my-tasks "WiNEX-Emergency"
```

### 工作项状态流转

- **Task**: New → Active → Closed
- **Bug**: New → Active → Resolved → Closed
- **User Story**: New → Active → Resolved → Closed

### TFS Web 访问

- TFS 首页: http://tfs2018-web.winning.com.cn:8080/tfs/
- Web Portal: http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0/_home
