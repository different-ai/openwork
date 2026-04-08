[![Discord](https://img.shields.io/badge/discord-加入-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

[English](../README.md) | 繁體中文 | [其他語言](./README.md)

# OpenWork
> 讓您的公司提升 1000 倍的生產力。

我們為 AI 智能體配備您團隊已經在使用的工具，並讓它們從您的行為中學習。您使用 OpenWork 越多，工具之間的連接就越緊密，積累的知識就越多，能夠自動化的工作塊就越大。

OpenWork 是 opencode 的最簡單介面。雙擊，選擇一個資料夾，即可立即獲得三大核心優勢：
1. 零摩擦設置 — 您現有的 opencode 配置開箱即用，無需遷移
2. 聊天集成 — WhatsApp 和 Telegram 即時可用（一個令牌，全部搞定）
3. 雲端就緒 — 每個應用都可以作為客戶端；部署到雲端，隨時隨地訪問
> **創建安全智能體工作流程並與團隊共享的最簡單方式**

它是 "Claude Work" 的**可擴展開源替代品**。


<img width="1292" height="932" alt="Screenshot 2026-01-31 at 16 22 39" src="https://github.com/user-attachments/assets/5742be91-9cfb-4212-b32d-cf2a27b1c093" />


<img width="1292" height="932" alt="Screenshot 2026-01-31 at 13 43 30" src="https://github.com/user-attachments/assets/6639d1ef-c831-406e-a812-87fde403e6d5" />


OpenWork 圍繞一個核心理念設計：讓您可以輕鬆地將智能體工作流程作為可重複的、產品化的流程進行交付。

它是一個原生桌面應用程式，底層運行 **OpenCode**，但將其呈現為簡潔的引導式工作流程：
- 選擇工作區
- 開始運行
- 觀察進度 + 計劃更新
- 需要時批准權限
- 重用有效的方法（命令 + 技能）

目標：讓"智能體工作"感覺像一個產品，而不是終端。

## 其他介面

- **Owpenbot (WhatsApp 機器人)**：為運行中的 OpenCode 伺服器提供的輕量級 WhatsApp 橋接器。安裝方法：
  - `curl -fsSL https://raw.githubusercontent.com/different-ai/owpenbot/dev/install.sh | bash`
  - 運行 `owpenbot setup`，然後 `owpenbot whatsapp login`，接著 `owpenbot start`
  - 完整設置：https://github.com/different-ai/owpenbot/blob/dev/README.md
- **Openwrk (CLI 主機)**：無需桌面 UI 即可運行 OpenCode + OpenWork 伺服器。使用 `npm install -g openwrk` 安裝。
  - 文檔：[apps/orchestrator/README.md](../apps/orchestrator/README.md)


## 快速開始
在此處下載 dmg：https://github.com/different-ai/openwork/releases（或按照下面的說明從源代碼安裝）

## 為什麼選擇 OpenWork

當前 opencode 的 CLI 和 GUI 都以開發者為中心。這意味著專注於檔案差異、工具名稱，以及在不依賴某種形式的 CLI 的情況下難以擴展的功能。

OpenWork 的設計目標是：
- **可擴展**：技能和 opencode 插件是可安裝的模組。
- **可審計**：顯示發生了什麼、何時發生以及為什麼發生。
- **權限控制**：訪問特權流程。
- **本地/遠端**：OpenWork 可以在本地工作，也可以連接到遠端伺服器。

## 包含的功能

- **主機模式**：在您的電腦上本地運行 opencode
- **客戶端模式**：通過 URL 連接到現有的 OpenCode 伺服器
- **會話**：創建/選擇會話並發送提示
- **實時流傳輸**：SSE `/event` 訂閱以獲取實時更新
- **執行計劃**：將 OpenCode 待辦事項呈現為時間線
- **權限**：顯示權限請求並回覆（允許一次/始終允許/拒絕）
- **模板**：保存並重新運行常見工作流程（本地存儲）
- **技能管理器**：
  - 列出已安裝的 `.opencode/skills` 資料夾
  - 將本地技能資料夾導入到 `.opencode/skills/<skill-name>`
 

## 技能管理器    
<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />


## 適用於本地電腦或伺服器
<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />


## 快速開始

### 系統要求

- Node.js + `pnpm`
- Rust 工具鏈（用於 Tauri）：通過 `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` 安裝
- Tauri CLI：`cargo install tauri-cli`
- 已安裝 OpenCode CLI 且可在 PATH 中使用：`opencode`

### 安裝

```bash
pnpm install
```

OpenWork 現在位於 `packages/app`（UI）和 `packages/desktop`（桌面外殼）中。

### 運行（桌面版）

```bash
pnpm dev
```

### 運行（僅 Web UI）

```bash
pnpm dev:ui
```

### Arch 用戶：

```bash
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## 架構（高級）

- 在**主機模式**中，OpenWork 啟動：
  - `opencode serve --hostname 127.0.0.1 --port <free-port>`
  - 以您選擇的專案資料夾作為進程工作目錄。
在主機模式下，OpenWork 直接在您的電腦後台啟動 OpenCode 伺服器。
當您選擇專案資料夾時，OpenWork 使用該資料夾在本地運行 OpenCode 並將桌面 UI 連接到它。
這允許您完全在您的機器上運行智能體工作流程、發送提示並查看進度，而無需依賴遠端伺服器。

- UI 使用 `@opencode-ai/sdk/v2/client` 來：
  - 連接到伺服器
  - 列出/創建會話
  - 發送提示
  - 訂閱 SSE 事件（即「伺服器發送事件」，用於從伺服器向 UI 流式傳輸實時更新）
  - 讀取待辦事項和權限請求



## 資料夾選擇器

資料夾選擇器使用 Tauri 對話框插件。
功能權限在以下檔案中定義：
- `packages/desktop/src-tauri/capabilities/default.json`

## OpenCode 插件

插件是擴展 OpenCode 的**原生**方式。OpenWork 現在通過從技能選項卡讀取和寫入 `opencode.json` 來管理它們。

- **專案範圍**：`<workspace>/opencode.json`
- **全局範圍**：`~/.config/opencode/opencode.json`（或 `$XDG_CONFIG_HOME/opencode/opencode.json`）

您仍然可以手動編輯 `opencode.json`；OpenWork 使用與 OpenCode CLI 相同的格式：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## 有用的命令

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## 故障排除

### Linux / Wayland (Hyprland)

如果 OpenWork 在啟動時因 WebKitGTK 錯誤（如 `Failed to create GBM buffer`）而崩潰，請在啟動前禁用 dmabuf 或合成。嘗試以下環境標誌之一。

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## 安全說明

- OpenWork 默認隱藏模型推理和敏感工具元數據。
- 主機模式默認綁定到 `127.0.0.1`。

## 貢獻

- 在進行更改之前，請查看 `AGENTS.md` 以及 `VISION.md`、`PRINCIPLES.md`、`PRODUCT.md` 和 `ARCHITECTURE.md` 以了解產品目標。
- 在倉庫內工作之前，確保已安裝 Node.js、`pnpm`、Rust 工具鏈和 `opencode`。
- 每次檢出後運行一次 `pnpm install`，然後在打開 PR 之前使用 `pnpm typecheck` 加上 `pnpm test:e2e`（或目標腳本子集）驗證您的更改。
- 按照 `AGENTS.md` 中描述的 `.opencode/skills/prd-conventions/SKILL.md` 約定，將新的 PRD 添加到 `packages/app/pr/<name>.md`。

## 面向團隊和企業

有興趣在您的組織中使用 OpenWork？我們很樂意聽取您的意見 — 請發送郵件至 [benjamin.shafii@gmail.com](mailto:benjamin.shafii@gmail.com) 與我們討論您的用例。

## 許可證

MIT — 請參見 `LICENSE`。
