# artifacts/
> L2 | 父级: ../../../../../AGENTS.md

会话 Artifact 模块把 Agent 在工作区生成的普通文件投影成可查看、可编辑、可下载的用户界面；文件与 Server API 是事实来源，渲染器只负责按预览类型解释内容，不保存平行业务状态。

## 成员清单

- `open-target.ts`: 从会话文本和工具结果提取 URL/文件引用，分类预览类型并决定哪些产物进入侧栏。
- `artifact-panel.tsx`: 读取、保存和打开工作区产物，按预览类型装配文本、表格、HTML、图片与 PDF 渲染器。
- `preview.tsx`: Markdown、纯文本、HTML、图片、PDF 的无状态预览组件。
- `artifact-icon.tsx`: 预览类型到一致图标语义的映射。
- `artifact-text-editor.tsx`: CodeMirror 文本/Markdown 编辑器与保存回调边界。
- `markdown-live-preview.ts`: CodeMirror Markdown 语法装饰，把原始标记和可编辑富文本合并呈现。
- `artifact-spreadsheet-editor.tsx`: CSV/TSV/Office 表格的交互编辑、脏状态和保存编排。
- `artifact-spreadsheet-model.ts`: 表格格式解析、标准化与序列化的纯数据模型。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
