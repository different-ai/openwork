# Intent: Workspace File Explorer

## Why

用户需要在 OpenWork Dashboard 中直接查看工作区的代码文件结构，无需切换到外部编辑器。这将提升开发效率，使 OpenWork 成为更完整的开发环境。

## Scope

### In Scope
- 在 Dashboard 左侧工作区列表添加二级切换（Sessions / Files）
- 实现文件树浏览（递归目录结构）
- 实现文件内容预览（代码高亮，只读模式）
- 支持常见代码文件类型（JS/TS/CSS/HTML/JSON/Markdown 等）

### Out of Scope
- 文件编辑功能（先只读）
- 文件创建/删除/重命名
- 搜索功能
- Git 集成

## Success Criteria

- [x] 用户可以在工作区下切换到 Files 视图
- [x] 文件树正确显示目录结构
- [x] 点击文件在中间区域显示内容
- [x] 代码文件有语法高亮
- [x] 大文件（>1MB）有性能保护

## Risks

| 风险 | 缓解措施 |
|------|----------|
| 大目录加载慢 | 懒加载 + 虚拟滚动 |
| 大文件卡顿 | 限制预览大小（<100KB） |
| 二进制文件 | 显示"不支持预览"提示 |

## Stakeholders

- 最终用户：需要在 OpenWork 中查看代码的开发者

---

**Status**: Draft  
**Created**: 2025-02-11  
**Author**: OpenWork Team
