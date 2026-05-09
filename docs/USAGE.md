# autoDoc 使用指南

一份完整上手教程：从环境准备，到生成第一份文档，到用 Code Agent 直接读写文档。

中文 · [English](#english) · [日本語](#日本語)

---

## 1. 你需要准备什么

- **Node.js 18+** 和 **pnpm 10+**
- **git 命令行**（系统自带的 `git` 即可，autoDoc 会在后台调用它做 clone / fetch / diff）
- **至少一个 Agent 后端**（Scaffold / Decomposer / Writer / Checker / Flow Analyzer / Updater / Knowledge 可按角色独立选；当前默认是 Codex 为主，Checker 为 Claude）：
  - Claude：装好 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 并确保能跑通 `claude` 命令
  - Codex：`npm i -g @openai/codex`，首次 `codex` 按提示登录 ChatGPT 账号或配置 API key
- **（可选）OpenAI API Key**：仅用于文档页右下角的 AI 对话面板

## 2. 安装与启动

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..

# 一键启动后端（端口 3100）和前端
pnpm start
```

看到后端打印 `listening on 3100` 且前端 Vite 输出本地地址后，打开浏览器访问前端地址（通常是 `http://localhost:5173`）。

## 3. 生成第一份文档

1. 在首页的输入框粘贴一条 **git URL**，SSH 或 HTTPS 都行：
   - `git@github.com:owner/repo.git`
   - `https://github.com/owner/repo.git`
2. 选语言（中文 / English）和每个角色用哪个 Agent 后端（保持默认即可）。
3. 按需要调整并发数（默认 8，API吃得消可以往上），也可以打开 **Review all decompositions**，让 Scaffold / Decomposer 产物先经过人工审核。
4. 点 **开始 / Start**；首次生成会先进入 Knowledge 页面，你可以补充业务背景，也可以直接跳过使用默认行为。

此时后端会：

1. 自动 `git clone` 到 `src/souko/repo/{项目名}/`
2. 可选收集 `knowledge.md`，并跑 **Scaffold → Checker → Decomposer → Checker → Writer** 生成完整文档内容
3. 写入目标仓库的 `.mcp.json`、`.codex/config.toml` 和 `.codex/skills/doc-drill/SKILL.md`，让 MCP / doc-drill 先可用；此时 `get_flows` 会提示 flow 尚未生成
4. 基于完整文档内容和源码运行 **Flow Analyzer**，由它创建 `flows.json`
5. 在 `src/souko/projects.json` 里登记 sourceUrl / branch / head / lastUpdated

**进度面板**实时显示当前阶段和每个节点的状态。如果中途卡住或手动停掉服务，重新 `pnpm start` 后再次点开始会从断点恢复，不会从零重跑。

## 4. 浏览已生成的文档

- **首页** 左侧下拉可以切换项目；切换时 git URL 输入框会自动填入该项目对应的源码地址。
- **架构总览（Graph）**：从顶层模块图开始点击节点逐层下钻。边悬浮可以看到模块间关系类型（调用 / 依赖 / 数据流 / 事件 / 继承 / 组合），右上角可以过滤节点，节点卡片上的 focus 可突出相关邻居。
- **文档页**：叶子节点就是一份 Markdown，右下角可开启 AI 对话追问（需要 `OPENAI_API_KEY`）。
- **交互流程图**：点 **Flows**，查看端到端业务流程的时序图。
- **搜索**：侧边栏搜索框跨所有层级按关键字查节点。

## 5. 增量更新（PR 驱动）

源仓库有新的 merged PR 或 commit 后，在首页点击项目卡片上的 **Update** 按钮（不是 Start），右侧会滑出 **Update Queue** 面板：

1. 选择模式：
   - **Auto**：全自动，PR 逐条处理，无需干预
   - **Manual**：每条 PR 都会弹出 chatbox 弹窗，展示 PR 标题、描述、改动文件列表，你可以输入额外提示词引导 agent。agent 跑完后进入 **awaiting-review** 状态，你可以：
     - **Accept** — 确认这条修改，推进到下一条
     - **Send follow-up** — 输入追加提示词让 agent 继续微调（session 续写，不丢上下文）
2. 点 **Start Update**，后端会：
   - `git fetch origin main` 拉最新
   - 通过 `gh pr list`（GitHub 项目）或 `git log --first-parent`（非 GitHub）发现 cursor 之后所有新合并的 PR/commit
   - 逐条串行处理：PrUpdater Agent 通过 MCP 工具自主导航文档树，做针对性修改（`patch_page` / `update_page` / `create_node` 等）
   - 每条 PR 处理完后自动推进 cursor（`lastProcessedSha`），服务重启后从断点继续

进度通过 SSE 实时推送到前端，任务卡片会显示 idle → running（带 shimmer 动画）→ done / awaiting-review 的状态流转。

## 6. 让 Code Agent 直接读写文档（MCP）

autoDoc 自带一个 HTTP MCP server，挂在同进程同端口的 `/mcp` 上，任何支持 Streamable HTTP 的 MCP 客户端都能接。对于团队来说，最好设置一个中心化的mcp server

在你希望使用文档的目标仓库（可以是任意一个项目，不必是 autoDoc 本身）根目录放一个 `.mcp.json`：

```json
{
  "mcpServers": {
    "autodoc": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

然后在 Claude Code 里开这个仓库，Agent 就能调用下面的工具。Codex 也可以用 autoDoc 写入的 `.codex/config.toml` 连接同一个 HTTP MCP。下面配置仅为 demo 使用，真实场景请使用中心化部署+鉴权配置，避免被意外修改：

| 类型 | 工具 | 说明 |
|---|---|---|
| Query | `list_projects` | 列出所有项目 |
| Query | `get_flows` | 读取典型跨模块交互流程 |
| Query | `get_top` / `get_graph` / `get_page` | 逐层读取结构和叶子文档 |
| Query | `search_nodes` | 按关键字搜 |
| Query | `list_source_files` / `read_source_files` | 定位并读取源码 |
| Query | `list_docs` / `read_docs` | 批量读取文档原文 |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | 修改图元数据或节点 |
| Mutate | `create_node` / `delete_node` | 增删节点 |
| Mutate | `patch_page` / `update_page` | 局部替换或覆写叶子 md |

所有 mutate 工具共用**项目级锁**：写操作会串行执行，只产生未提交变更。用户在前端 Git 面板里审阅 dirty 状态并手动提交；blame 信息也从 Git 提供。

同时，autoDoc 会在初步文档内容完成后，把一份超薄的 `doc-drill` skill 自动写进目标仓库的 `.codex/skills/doc-drill/SKILL.md`，并写入 Claude Code / Codex 对应的 MCP 配置，告诉 Agent 怎么用这些 MCP 工具。`get_flows` 在 `flows.json` 生成前会提示 flow 尚未生成，生成后即可返回典型流程。

> ⚠️ `/mcp` 默认无鉴权、CORS 开放，只适合本地/内网。部署到 公网/团队使用 请加访问控制或绑定 loopback。

## 7. 常用命令速查

```bash
# 启动后端 + 前端
pnpm start

# 只起后端
pnpm dev

# 前端单独起
cd web && pnpm dev

# 类型检查
npx tsc --noEmit                 # 后端
cd web && npx vue-tsc --noEmit   # 前端
```

## 8. 常见问题

- **粘了 URL 后一直转圈？** 确认系统 `git` 能在命令行手动 clone 这个仓库（SSH key / HTTPS 凭证都是你本机的 git 在管，autoDoc 不做额外鉴权）。
- **`mode: noop` 是什么意思？** 远端没新 commit，没活可干，直接返回，没浪费一次 Agent 调用。
- **想强制重生成怎么办？** 删掉 `src/souko/doc/{项目名}/` 和 `src/souko/projects.json` 里对应条目，再次提交同一 URL 就会走全量分支。
- **文档想人肉改？** 直接编辑 `src/souko/doc/{项目名}/` 下的 `.md` 或 `.json`，刷新即可，改动会显示在 Git 面板里等待手动提交。
- **Codex 后端报错找不到 profile？** 参考 README 里的 Codex Profile 配置，`~/.codex/config.toml` 里必须有 `scaffold` / `decomposer` / `writer` / `checker` / `flowanalyzer` / `prupdater` / `knowledge` 这些 profile 名。

---

<a id="english"></a>
## English

### 1. Prerequisites

- **Node.js 18+** and **pnpm 10+**
- **`git` CLI** (autoDoc shells out to it for clone / fetch / diff)
- **At least one Agent backend** (Scaffold / Decomposer / Writer / Checker / Flow Analyzer / Updater / Knowledge are independently configurable; current defaults are Codex-first with Checker on Claude):
  - Claude: install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and make sure the `claude` command works
  - Codex: `npm i -g @openai/codex`, run `codex` once and sign in with your ChatGPT account or configure an API key
- **(Optional) OpenAI API key**: only needed for the AI chat panel on doc pages

### 2. Install & Run

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
pnpm start
```

Once the backend prints `listening on 3100` and the frontend Vite dev server is up, open the frontend URL in your browser (usually `http://localhost:5173`).

### 3. Generate your first doc

1. Paste a **git URL** (SSH or HTTPS) into the input on the home page
2. Pick the language and per-role Agent backends (defaults are fine)
3. Adjust concurrency if you want (default 8), and optionally enable **Review all decompositions** to manually approve Scaffold / Decomposer outputs
4. Click **Start**; first-time generation opens the Knowledge page where you can add domain context or skip and use defaults

The backend will then:

1. `git clone` into `src/souko/repo/{name}/`
2. Optionally collect `knowledge.md`, then run **Scaffold → Checker → Decomposer → Checker → Writer** to complete the documentation content
3. Write the target repo's `.mcp.json`, `.codex/config.toml`, and `.codex/skills/doc-drill/SKILL.md` so MCP / doc-drill are available; `get_flows` reports that flows have not been generated yet
4. Run **Flow Analyzer** against the completed docs and source repo so it creates `flows.json`
5. Register `sourceUrl` / `branch` / `head` / `lastUpdated` in `src/souko/projects.json`

The progress panel shows live phase + per-node status. If the server is killed mid-run, restarting `pnpm start` and hitting Start again will resume from the saved session state instead of starting over.

### 4. Browse generated docs

- **Home**: the sidebar dropdown switches projects. Switching a project auto-populates the git URL input with that project's source URL.
- **Graph overview**: click nodes to drill down through layers. Hover edges for relationship type (calls / depends / data-flow / event / extends / composes); use the node filter and focus controls to isolate crowded graphs.
- **Doc pages**: leaf nodes are Markdown pages with an optional AI chat panel (needs `OPENAI_API_KEY`).
- **Flows**: open the Flows view for sequence-diagrams of end-to-end business flows.
- **Search**: the sidebar search box matches node names and descriptions across all layers.

### 5. Incremental update (PR-driven)

When upstream has new merged PRs or commits, click the **Update** button on the project card (not Start). The **Update Queue** panel slides out on the right:

1. Pick a mode:
   - **Auto**: fully automatic, PRs processed one by one with no user interaction
   - **Manual**: each PR opens a chatbox dialog showing the PR title, description, and changed file list. You can type additional guidance for the agent. After the agent finishes, the task enters **awaiting-review** — you can:
     - **Accept** — confirm the doc changes and advance to the next PR
     - **Send follow-up** — type a refinement prompt; the agent continues its session (no context loss)
2. Click **Start Update**. The backend will:
   - `git fetch origin main`
   - Discover all merged PRs/commits since the cursor via `gh pr list` (GitHub) or `git log --first-parent` (fallback)
   - Process each one serially: PrUpdater Agent navigates the doc tree via MCP tools and applies targeted edits (`patch_page` / `update_page` / `create_node` etc.)
   - After each PR, the cursor (`lastProcessedSha`) advances; restart the server and it picks up where it left off

Progress streams in real-time via SSE. Task cards show idle → running (shimmer animation) → done / awaiting-review.

### 6. Let Code Agents read/write docs (MCP)

autoDoc ships an HTTP MCP server on the same process and port, at `/mcp`. Any Streamable-HTTP MCP client can connect.

Drop an `.mcp.json` into the root of any repository you want to use the docs from:

```json
{
  "mcpServers": {
    "autodoc": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Open that repo in Claude Code and the Agent will have access to these tools. Codex can use the `.codex/config.toml` that autoDoc writes to connect to the same HTTP MCP server:

| Kind | Tool | Purpose |
|---|---|---|
| Query | `list_projects` | List all registered projects |
| Query | `get_flows` | Read typical cross-module interaction flows |
| Query | `get_top` / `get_graph` / `get_page` | Read structure and leaf docs layer by layer |
| Query | `search_nodes` | Keyword search |
| Query | `list_source_files` / `read_source_files` | Locate and read source files |
| Query | `list_docs` / `read_docs` | Batch-read raw docs |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | Patch metadata or a node |
| Mutate | `create_node` / `delete_node` | Add or remove nodes |
| Mutate | `patch_page` / `update_page` | Patch or overwrite a leaf md |

Every mutate tool shares a **project-level lock**: writes are serialized and dirty the working tree. The user reviews dirty status and commits from the frontend Git panel; blame data also comes from Git.

After the initial documentation content is complete, autoDoc installs a thin `doc-drill` skill into the target repo's `.codex/skills/doc-drill/SKILL.md` and writes the Claude Code / Codex MCP config that tells Agents how to use these tools. `get_flows` reports that flows have not been generated until `flows.json` exists, then returns the typical flows.

> ⚠️ `/mcp` is unauthenticated and CORS-open by default — suitable for local/intranet use only. Put it behind access control or bind to loopback before public deployment.

### 7. Command cheat sheet

```bash
pnpm start                        # backend + frontend
pnpm dev                          # backend only
cd web && pnpm dev                # frontend only
npx tsc --noEmit                  # type-check backend
cd web && npx vue-tsc --noEmit    # type-check frontend
```

### 8. FAQ

- **Stuck spinning after pasting a URL?** Make sure your system `git` can clone that repo manually — autoDoc uses your existing SSH key / HTTPS credentials, it does no extra auth.
- **What is `mode: noop`?** Upstream has no new commits, so nothing to do — skipped without touching an Agent.
- **How do I force a full regen?** Delete `src/souko/doc/{name}/` and the matching entry in `src/souko/projects.json`, then resubmit the same URL.
- **Can I edit docs by hand?** Yes — edit `.md` / `.json` directly under `src/souko/doc/{name}/`, refresh, and commit the resulting dirty changes from the Git panel.
- **Codex says profile not found?** Check your `~/.codex/config.toml`: it must define profiles named exactly `scaffold`, `decomposer`, `writer`, `checker`, `flowanalyzer`, `prupdater`, `knowledge`.

---

<a id="日本語"></a>
## 日本語

### 1. 前提条件

- **Node.js 18+** と **pnpm 10+**
- **`git` コマンドライン**（autoDoc が clone / fetch / diff のため直接呼び出します）
- **少なくとも 1 つの Agent バックエンド**（Scaffold / Decomposer / Writer / Checker / Flow Analyzer / Updater / Knowledge を個別設定可能。現在のデフォルトは Codex 中心、Checker は Claude）:
  - Claude: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) をインストールして `claude` コマンドが動作することを確認
  - Codex: `npm i -g @openai/codex`、初回 `codex` で ChatGPT アカウントログインか API キー設定
- **（オプション）OpenAI API キー**: ドキュメントページの AI チャットパネル用

### 2. インストール & 起動

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
pnpm start
```

バックエンドが `listening on 3100` を出し、フロントエンドの Vite dev server が起動したら、ブラウザで `http://localhost:5173` を開きます。

### 3. 最初のドキュメントを生成

1. ホーム画面の入力欄に **git URL**（SSH / HTTPS どちらも可）を貼り付け
2. 言語と各ロールの Agent バックエンドを選択（デフォルトで OK）
3. 必要なら並行数を調整（デフォルト 8）。**Review all decompositions** を有効にすると Scaffold / Decomposer 出力を手動承認できます
4. **開始** をクリック。初回生成では Knowledge ページが開き、ドメイン背景を追加するか、スキップして既定動作で進められます

バックエンドが以下を実行します:

1. `src/souko/repo/{プロジェクト名}/` に `git clone`
2. 必要に応じて `knowledge.md` を収集し、**Scaffold → Checker → Decomposer → Checker → Writer** でドキュメント内容を完成
3. 対象リポジトリの `.mcp.json`、`.codex/config.toml`、`.codex/skills/doc-drill/SKILL.md` を書き込み、MCP / doc-drill を先に利用可能にします。この時点の `get_flows` は flow 未生成を通知します
4. 完成したドキュメントとソースを元に **Flow Analyzer** を実行し、Flow Analyzer 自身が `flows.json` を作成
5. `src/souko/projects.json` に sourceUrl / branch / head / lastUpdated を登録

進捗パネルが現在のフェーズとノード毎の状態をリアルタイム表示します。途中でサーバーが止まっても、`pnpm start` で再起動し再度開始を押すとセッション状態から途中再開します。

### 4. 生成されたドキュメントを閲覧

- **ホーム**: サイドバーのドロップダウンでプロジェクト切替。切り替えると git URL 入力欄に対応するソース URL が自動入力されます。
- **架構総覧（Graph）**: トップレベルからノードをクリックして階層的に掘り下げ。エッジにホバーで関係タイプ表示。ノードフィルターと focus 操作で混雑したグラフを絞り込めます。
- **ドキュメントページ**: リーフノードは Markdown。右下の AI チャットで追加質問可能（`OPENAI_API_KEY` が必要）。
- **フロー図**: Flows ビューで端々到端のビジネスフローをシーケンス図として表示。
- **検索**: サイドバーの検索ボックスで全階層からキーワード検索。

### 5. 増分更新（PR 駆動）

upstream に新しくマージされた PR や commit がある場合、プロジェクトカードの **Update** ボタンをクリック（Start ではなく）。右側に **Update Queue** パネルがスライドアウトします:

1. モードを選択:
   - **Auto**: 完全自動。PR を 1 件ずつ順番に処理し、ユーザー操作不要
   - **Manual**: 各 PR で chatbox ダイアログが開き、PR タイトル・説明・変更ファイルリストが表示されます。Agent への追加ガイダンスを入力できます。Agent 完了後 **awaiting-review** 状態に入り:
     - **Accept** — 変更を確認し、次の PR に進む
     - **Send follow-up** — 微調整プロンプトを追加入力（セッション継続、コンテキスト保持）
2. **Start Update** をクリック。バックエンドが:
   - `git fetch origin main` で最新取得
   - `gh pr list`（GitHub プロジェクト）または `git log --first-parent`（フォールバック）でカーソル以降の全マージ PR/commit を検出
   - 直列で 1 件ずつ処理: PrUpdater Agent が MCP ツール経由でドキュメントツリーを自律ナビゲーションし、標的編集を実行（`patch_page` / `update_page` / `create_node` 等）
   - 各 PR 処理後にカーソル（`lastProcessedSha`）を更新、サーバー再起動後も中断地点から再開

進捗は SSE でリアルタイム配信。タスクカードが idle → running（シマーアニメーション）→ done / awaiting-review と状態遷移します。

### 6. Code Agent からドキュメントを読み書き（MCP）

autoDoc は同一プロセス同一ポートの `/mcp` に HTTP MCP サーバーを公開します。Streamable HTTP 対応の MCP クライアントならなんでも接続可能です。

ドキュメントを使いたい任意のリポジトリ（autoDoc 自身でなくても OK）のルートに `.mcp.json` を置きます:

```json
{
  "mcpServers": {
    "autodoc": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

そのリポジトリを Claude Code で開けば、Agent が以下のツールを使えます。Codex は autoDoc が書き込む `.codex/config.toml` から同じ HTTP MCP server に接続できます:

| 種類 | ツール | 用途 |
|---|---|---|
| Query | `list_projects` | 全プロジェクト一覧 |
| Query | `get_flows` | 典型的なモジュール間インタラクションフローを読む |
| Query | `get_top` / `get_graph` / `get_page` | 構造とリーフを階層的に読む |
| Query | `search_nodes` | キーワード検索 |
| Query | `list_source_files` / `read_source_files` | ソースファイルの探索と読み取り |
| Query | `list_docs` / `read_docs` | ドキュメント原文の一括読み取り |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | メタデータやノードの更新 |
| Mutate | `create_node` / `delete_node` | ノード追加削除 |
| Mutate | `patch_page` / `update_page` | リーフ md の局所修正または上書き |

すべての mutate ツールは**project-level lock**を共有します。書き込みは直列化され、working tree を dirty にします。ユーザーが frontend Git panel で dirty 状態を確認して手動 commit します。blame 情報も Git から取得します。

初期ドキュメント内容が完成した後、autoDoc はスリム版 `doc-drill` skill を対象リポジトリの `.codex/skills/doc-drill/SKILL.md` に自動インストールし、Claude Code / Codex 用の MCP 設定も書き込んで Agent にツールの使い方を教えます。`flows.json` ができるまでは `get_flows` が flow 未生成を通知し、生成後は典型 flow を返します。

> ⚠️ `/mcp` はデフォルトで無認証・CORS 開放です。ローカル / 社内ネットワーク向け。公開環境に出す前にアクセス制御を追加するかループバックに bind してください。

### 7. コマンドチートシート

```bash
pnpm start                        # backend + frontend
pnpm dev                          # backend のみ
cd web && pnpm dev                # frontend のみ
npx tsc --noEmit                  # backend 型チェック
cd web && npx vue-tsc --noEmit    # frontend 型チェック
```

### 8. FAQ

- **URL を貼ってもぐるぐる回ったまま？** システムの `git` がそのリポジトリをコマンドラインから手動で clone できるか確認してください。autoDoc は追加認証を行わず、既存の SSH key / HTTPS 認証をそのまま使います。
- **`mode: noop` とは？** upstream に新 commit がない、つまり何もする必要がない状態。Agent を 1 回も呼ばずに終わります。
- **強制的に全量再生成したい？** `src/souko/doc/{プロジェクト名}/` と `src/souko/projects.json` の該当エントリを削除してから、同じ URL を再投入してください。
- **ドキュメントを手で編集したい？** `src/souko/doc/{プロジェクト名}/` 配下の `.md` / `.json` を直接編集できます。refresh 後、Git panel に未コミット変更として表示されます。
- **Codex が profile が見つからないと言う？** `~/.codex/config.toml` に `scaffold` / `decomposer` / `writer` / `checker` / `flowanalyzer` / `prupdater` / `knowledge` という名前の profile がすべて必要です。
