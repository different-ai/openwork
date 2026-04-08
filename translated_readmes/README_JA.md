[![Discord](https://img.shields.io/badge/discord-加入-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

[English](../README.md) | 日本語 | [他の翻訳README](./README.md)

# OpenWork
> OpenWorkは、Claude Cowork/Codex（デスクトップアプリ）のオープンソース代替です。

## 基本理念

- ローカルファースト、クラウド対応: OpenWorkはワンクリックであなたのマシン上で動作します。メッセージを即座に送信できます。
- コンポーザブル: デスクトップアプリ、WhatsApp/Slack/Telegramコネクタ、またはサーバー。用途に合ったものを使えます。ロックインなし。
- エジェクタブル: OpenWorkはOpenCodeで動いているため、OpenCodeでできることはすべてOpenWorkでも動作します（UIがなくても）。
- シェアリング・イズ・ケアリング: localhostでソロ作業を始め、必要に応じてリモート共有を明示的にオプトインできます。

<p align="center">
  <img src="../app-demo.gif" alt="OpenWork デモ" width="800" />
</p>

OpenWorkは、エージェントワークフローを再現可能なプロダクト化されたプロセスとして簡単にリリースできるように設計されています。

## 代替UI
- **OpenWork Orchestrator（CLIホスト）**: デスクトップUIなしでOpenCode + OpenWorkサーバーを実行します。
  - インストール: `npm install -g openwork-orchestrator`
  - 実行: `openwork start --workspace /path/to/workspace --approval auto`
  - ドキュメント: [apps/orchestrator/README.md](../apps/orchestrator/README.md)

## クイックスタート

デスクトップアプリを[openworklabs.com/download](https://openworklabs.com/download)からダウンロードするか、最新の[GitHubリリース](https://github.com/different-ai/openwork/releases)を取得するか、以下の手順でソースからインストールしてください。

- macOSおよびLinux向けのダウンロードが直接利用可能です。
- Windowsへのアクセスは現在、[openworklabs.com/pricing#windows-support](https://openworklabs.com/pricing#windows-support)の有料サポートプランで提供されています。
- ホステッドOpenWork Cloudワーカーは、チェックアウト後にWebアプリから起動し、デスクトップアプリから`Add a worker` -> `Connect remote`で接続します。

## なぜOpenWorkか

現在のOpenCode向けCLIやGUIは開発者を中心に設計されています。つまり、ファイルの差分、ツール名、そしてCLIを公開しなければ拡張が難しい機能に焦点が当てられています。

OpenWorkは以下を目指して設計されています:

- **拡張可能**: スキルとOpenCodeプラグインはインストール可能なモジュールです。
- **監査可能**: 何が、いつ、なぜ起きたかを表示します。
- **権限管理**: 特権フローへのアクセスを制御します。
- **ローカル/リモート**: OpenWorkはローカルでもリモートサーバーへの接続でも動作します。

## 含まれる機能

- **ホストモード**: ローカルコンピュータ上でOpenCodeを実行します。
- **クライアントモード**: URLで既存のOpenCodeサーバーに接続します。
- **セッション**: セッションの作成/選択とプロンプトの送信。
- **ライブストリーミング**: SSE `/event` サブスクリプションによるリアルタイム更新。
- **実行計画**: OpenCodeのTodoをタイムラインとして表示。
- **権限**: 権限リクエストを表示し、応答（一度許可 / 常に許可 / 拒否）。
- **テンプレート**: 一般的なワークフローを保存して再実行（ローカル保存）。
- **デバッグエクスポート**: バグ報告時に、設定 -> デバッグからランタイムデバッグレポートと開発者ログストリームをコピーまたはエクスポート。
- **スキルマネージャー**:
  - インストール済みの `.opencode/skills` フォルダを一覧表示
  - ローカルのスキルフォルダを `.opencode/skills/<skill-name>` にインポート

## スキルマネージャー

<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

## ローカルコンピュータまたはサーバーで動作

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />

## クイックスタート

### 必要要件

- Node.js + `pnpm`
- Rustツールチェーン（Tauri用）: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` でインストール
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLIがPATH上にインストールされていること: `opencode`

### ローカル開発の前提条件（デスクトップ）

`pnpm dev` を実行する前に、以下がシェルにインストールされ有効になっていることを確認してください:

- Node + pnpm（リポジトリは `pnpm@10.27.0` を使用）
- **Bun 1.3.9+**（`bun --version`）
- Rustツールチェーン（Tauri用）、現在の `rustup` stableからのCargo（`Cargo.lock` v4対応）
- Xcode Command Line Tools（macOS）
- Linux環境では、`pkg-config` が `webkit2gtk-4.1` と `javascriptcoregtk-4.1` を解決できるようにWebKitGTK 4.1開発パッケージが必要

### 1分間の動作確認

リポジトリルートから実行:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @openwork/desktop exec tauri --version
```

### インストール

```bash
pnpm install
```

OpenWorkは現在 `apps/app`（UI）と `apps/desktop`（デスクトップシェル）に配置されています。

### 実行（デスクトップ）

```bash
pnpm dev
```

`pnpm dev` は自動的に `OPENWORK_DEV_MODE=1` を有効にするため、デスクトップ開発では個人のグローバル設定/認証/データの代わりに分離されたOpenCode状態を使用します。

### 実行（Web UIのみ）

```bash
pnpm dev:ui
```

リポジトリのすべての `dev` エントリポイントは同じ開発モード分離にオプトインするため、ローカルテストでは一貫してOpenWork管理のOpenCode状態を使用します。

### Archユーザー向け:

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## アーキテクチャ（概要）

- **ホストモード**では、OpenWorkはローカルホストスタックを実行し、UIをそれに接続します。
  - デフォルトランタイム: `openwork`（`openwork-orchestrator` からインストール）。`opencode`、`openwork-server`、およびオプションで `opencode-router` をオーケストレーションします。
  - フォールバックランタイム: `direct`。デスクトップアプリが直接 `opencode serve --hostname 127.0.0.1 --port <free-port>` を起動します。

プロジェクトフォルダを選択すると、OpenWorkはそのフォルダを使用してローカルでホストスタックを実行し、デスクトップUIを接続します。
これにより、リモートサーバーなしで完全にマシン上でエージェントワークフローの実行、プロンプトの送信、進捗の確認が可能です。

- UIは `@opencode-ai/sdk/v2/client` を使用して:
  - サーバーに接続
  - セッションの一覧表示/作成
  - プロンプトの送信
  - SSEイベントのサブスクライブ（サーバーからUIへのリアルタイム更新のストリーミングにServer-Sent Eventsを使用）
  - Todoと権限リクエストの読み取り

## フォルダピッカー

フォルダピッカーはTauriダイアログプラグインを使用します。
ケイパビリティの権限は以下で定義されています:

- `apps/desktop/src-tauri/capabilities/default.json`

## OpenCodeプラグイン

プラグインはOpenCodeを拡張する**ネイティブ**な方法です。OpenWorkはスキルタブから `opencode.json` を読み書きして管理します。

- **プロジェクトスコープ**: `<workspace>/opencode.json`
- **グローバルスコープ**: `~/.config/opencode/opencode.json`（または `$XDG_CONFIG_HOME/opencode/opencode.json`）

`opencode.json` を手動で編集することもできます。OpenWorkはOpenCode CLIと同じ形式を使用します:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## 便利なコマンド

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## トラブルシューティング

デスクトップやセッションのバグを報告する必要がある場合は、Issueを作成する前に設定 -> デバッグからランタイムデバッグレポートと開発者ログの両方をエクスポートしてください。

### Linux / Wayland（Hyprland）

OpenWorkがWebKitGTKエラー（`Failed to create GBM buffer` など）で起動時にクラッシュする場合は、起動前にdmabufまたはコンポジティングを無効にしてください。以下のいずれかの環境変数フラグを試してください。

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## セキュリティに関する注意

- OpenWorkはデフォルトでモデルの推論と機密ツールメタデータを非表示にします。
- ホストモードはデフォルトで `127.0.0.1` にバインドします。

## コントリビューション

- 変更を行う前に、`AGENTS.md`、`VISION.md`、`PRINCIPLES.md`、`PRODUCT.md`、`ARCHITECTURE.md` を確認してプロダクトの目標を理解してください。
- リポジトリ内で作業する前に、Node.js、`pnpm`、Rustツールチェーン、および `opencode` がインストールされていることを確認してください。
- チェックアウトごとに `pnpm install` を実行し、PRを作成する前に `pnpm typecheck` と `pnpm test:e2e`（または対象のスクリプトサブセット）で変更を検証してください。
- PRを作成する際は `.github/pull_request_template.md` を使用し、実行したコマンド、結果、手動検証手順、およびエビデンスを含めてください。
- CIが失敗した場合は、PRの本文でコード関連のリグレッションか外部/環境/認証のブロッカーかを分類してください。
- 新しいPRDは `AGENTS.md` に記載されている `.opencode/skills/prd-conventions/SKILL.md` の規約に従い、`apps/app/pr/<name>.md` に追加してください。

コミュニティドキュメント:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

初回コントリビューションチェックリスト:

- [ ] `pnpm install` とベースライン検証コマンドを実行する。
- [ ] 変更に明確なIssueリンクとスコープがあることを確認する。
- [ ] 動作変更に対してテストを追加/更新する。
- [ ] PRに実行したコマンドと結果を含める。
- [ ] ユーザー向けフロー変更のスクリーンショット/動画を追加する。

## チーム・企業向け

組織でのOpenWork利用に興味がありますか？ぜひお聞かせください — [ben@openworklabs.com](mailto:ben@openworklabs.com) までユースケースについてご連絡ください。

## ライセンス

MIT — `LICENSE` をご確認ください。
