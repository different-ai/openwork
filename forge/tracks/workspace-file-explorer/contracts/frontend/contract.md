# Contract: Frontend - Workspace File Explorer

## ADDED

### Types

```typescript
// packages/app/src/app/types.ts

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  modified?: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  language?: string;
  readonly: true;
}

export type WorkspaceSecondaryTab = 'sessions' | 'files';
```

### Components

```typescript
// packages/app/src/app/components/file-tree.tsx
export interface FileTreeProps {
  workspacePath: string;
  expandedPaths: string[];
  selectedPath?: string;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
}

// packages/app/src/app/components/file-preview.tsx
export interface FilePreviewProps {
  filePath: string;
  content: string;
  language?: string;
}
```

### Tauri API

```typescript
// packages/app/src/app/lib/tauri.ts

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
}

export interface FileReadResult {
  content: string;
  size: number;
  language?: string;
}

export async function fsReadDir(path: string): Promise<FileEntry[]>;
export async function fsReadFile(path: string): Promise<FileReadResult>;
```

### Dashboard Props Extension

```typescript
// DashboardViewProps 扩展
{
  // 工作区二级标签状态
  workspaceSecondaryTabById: Record<string, WorkspaceSecondaryTab>;
  setWorkspaceSecondaryTab: (workspaceId: string, tab: WorkspaceSecondaryTab) => void;
  
  // 文件树状态
  expandedFilePathsByWorkspace: Record<string, string[]>;
  toggleFilePathExpanded: (workspaceId: string, path: string) => void;
  
  // 选中文件
  selectedFilePath?: string;
  setSelectedFilePath: (path: string | undefined) => void;
  
  // 文件预览
  filePreviewContent?: FileContent;
  filePreviewLoading: boolean;
  loadFilePreview: (path: string) => Promise<void>;
}
```

## MODIFIED

### Dashboard.tsx

- 工作区展开区域添加二级切换按钮（Sessions / Files）
- 根据 secondaryTab 渲染不同内容
- 添加 FileTree 组件集成

### Workspace State Management

- 扩展工作区状态管理，添加二级标签状态
- 添加文件树展开状态持久化

## REMOVED

N/A

---

**Status**: Draft  
**Domain**: Frontend  
**Parent**: workspace-file-explorer
