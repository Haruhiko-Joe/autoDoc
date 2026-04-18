# autoDoc 使用指南

一份完整上手教程：从环境准备，到生成第一份文档，到用 Code Agent 直接读写文档。

中文 · [English](#english) · [日本語](#日本語)

---

## 1. 你需要准备什么

- **Node.js 18+** 和 **pnpm 10+**
- **git 命令行**（系统自带的 `git` 即可，autoDoc 会在后台调用它做 clone / fetch / diff）
- **至少一个 Agent 后端**（六个角色可各自独立选，默认都是 Claude）：
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
3. 按需要调整并发数（默认 8，API吃得消可以往上）。
4. 点 **开始 / Start**。

此时后端会：

1. 自动 `git clone` 到 `src/souko/repo/{项目名}/`
2. 跑 **Scaffold → Checker → Decomposer → Checker → Writer → Flow Analyzer** 的全量管线
3. 把文档产物写进 `src/souko/doc/{项目名}/`
4. 在 `src/souko/projects.json` 里登记 sourceUrl / branch / head / lastUpdated

**进度面板**实时显示当前阶段和每个节点的状态。如果中途卡住或手动停掉服务，重新 `pnpm start` 后再次点开始会从断点恢复，不会从零重跑。

## 4. 浏览已生成的文档

- **首页** 左侧下拉可以切换项目；切换时 git URL 输入框会自动填入该项目对应的源码地址。
- **架构总览（Graph）**：从顶层模块图开始点击节点逐层下钻。边悬浮可以看到模块间关系类型（调用 / 依赖 / 数据流 / 事件 / 继承 / 组合）。
- **文档页**：叶子节点就是一份 Markdown，右下角可开启 AI 对话追问（需要 `OPENAI_API_KEY`）。
- **交互流程图**：点 **Flows**，查看端到端业务流程的时序图。
- **搜索**：侧边栏搜索框跨所有层级按关键字查节点。

## 5. 增量更新

源仓库有新 commit 后，你不需要删除旧文档——直接在首页粘贴**同一条 git URL** 再点开始：

- 后端先 `git fetch` 拉最新
- 比对 head：
  - **没变化** → 返回 `mode: noop`，零工作量
  - **有变化** → 计算 diff，**Updater Agent** 局部改写受影响的 `.md` / `.json`，不重跑全量管线

进度面板会显示 `Fetching latest commits...` → `Updater agent applying diff...` 两个阶段。

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

然后在 Claude Code 里开这个仓库，Agent 就能调用下面的工具，仅为demo使用，真实场景请使用中心化部署+鉴权配置，避免被意外修改：

| 类型 | 工具 | 说明 |
|---|---|---|
| Query | `list_projects` | 列出所有项目 |
| Query | `get_top` / `get_graph` / `get_page` | 逐层读取结构和叶子文档 |
| Query | `search_nodes` | 按关键字搜 |
| Query | `list_history` / `get_history` | 查看历史版本 |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | 修改图元数据或节点 |
| Mutate | `create_node` / `delete_node` | 增删节点 |
| Mutate | `update_page` | 覆写叶子 md |
| Mutate | `revert` | 回滚到历史版本 |

所有 mutate 工具都带**乐观锁**：写的时候要带 `baseVersion`，版本不对会返回 `VersionMismatch`，让 Agent 重读重试。每次写入自动在 `.history/` 里留一份快照，随时可以 `revert` 回去。

同时，autoDoc 会把一份超薄的 `doc-drill` skill 自动写进目标仓库的 `.claude/skills/doc-drill/`，告诉 Agent 怎么用这些 MCP 工具。

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
- **文档想人肉改？** 直接编辑 `src/souko/doc/{项目名}/` 下的 `.md` 或 `.json`，刷新即可（但会跳过 MCP 的 version 机制）。更推荐让 Agent 通过 MCP 改，能走历史快照。
- **Codex 后端报错找不到 profile？** 参考 README 里的 Codex Profile 配置，`~/.codex/config.toml` 里必须有 `scaffold` / `decomposer` / `writer` / `checker` / `flowanalyzer` / `updater` 这六个 profile 名。

---

<a id="english"></a>
## English

### 1. Prerequisites

- **Node.js 18+** and **pnpm 10+**
- **`git` CLI** (autoDoc shells out to it for clone / fetch / diff)
- **At least one Agent backend** (six roles, each independently configurable; defaults are all Claude):
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
3. Adjust concurrency if you want (default 8)
4. Click **Start**

The backend will then:

1. `git clone` into `src/souko/repo/{name}/`
2. Run the full **Scaffold → Checker → Decomposer → Checker → Writer → Flow Analyzer** pipeline
3. Write output to `src/souko/doc/{name}/`
4. Register `sourceUrl` / `branch` / `head` / `lastUpdated` in `src/souko/projects.json`

The progress panel shows live phase + per-node status. If the server is killed mid-run, restarting `pnpm start` and hitting Start again will resume from the saved session state instead of starting over.

### 4. Browse generated docs

- **Home**: the sidebar dropdown switches projects. Switching a project auto-populates the git URL input with that project's source URL.
- **Graph overview**: click nodes to drill down through layers. Hover edges for relationship type (calls / depends / data-flow / event / extends / composes).
- **Doc pages**: leaf nodes are Markdown pages with an optional AI chat panel (needs `OPENAI_API_KEY`).
- **Flows**: open the Flows view for sequence-diagrams of end-to-end business flows.
- **Search**: the sidebar search box matches node names and descriptions across all layers.

### 5. Incremental update

When upstream has new commits, **do not** delete the old docs. Just paste the **same git URL** on the home page and click Start again:

- Backend does `git fetch` first
- Compares heads:
  - **No change** → returns `mode: noop`, zero work
  - **Change** → computes the diff, hands it to the **Updater Agent** which patches affected `.md` / `.json` in place — no full rerun

The progress panel shows `Fetching latest commits...` → `Updater agent applying diff...`.

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

Open that repo in Claude Code and the Agent will have access to:

| Kind | Tool | Purpose |
|---|---|---|
| Query | `list_projects` | List all registered projects |
| Query | `get_top` / `get_graph` / `get_page` | Read structure and leaf docs layer by layer |
| Query | `search_nodes` | Keyword search |
| Query | `list_history` / `get_history` | Inspect historical versions |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | Patch metadata or a node |
| Mutate | `create_node` / `delete_node` | Add or remove nodes |
| Mutate | `update_page` | Overwrite a leaf md |
| Mutate | `revert` | Roll back to a historical version |

Every mutate tool enforces **optimistic locking**: writes must carry `baseVersion`, mismatches return `VersionMismatch`, and every write is snapshotted into `.history/` for `revert`.

autoDoc also installs a thin `doc-drill` skill into the target repo's `.claude/skills/doc-drill/` that tells Agents how to use these tools.

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
- **Can I edit docs by hand?** Yes — edit `.md` / `.json` directly under `src/souko/doc/{name}/`, but that bypasses MCP versioning. Prefer the MCP mutate tools if you want history snapshots.
- **Codex says profile not found?** Check your `~/.codex/config.toml`: it must define profiles named exactly `scaffold`, `decomposer`, `writer`, `checker`, `flowanalyzer`, `updater`.

---

<a id="日本語"></a>
## 日本語

### 1. 前提条件

- **Node.js 18+** と **pnpm 10+**
- **`git` コマンドライン**（autoDoc が clone / fetch / diff のため直接呼び出します）
- **少なくとも 1 つの Agent バックエンド**（6 ロールを個別に設定可能、デフォルトはすべて Claude）:
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
3. 必要なら並行数を調整（デフォルト 8）
4. **開始** をクリック

バックエンドが以下を実行します:

1. `src/souko/repo/{プロジェクト名}/` に `git clone`
2. **Scaffold → Checker → Decomposer → Checker → Writer → Flow Analyzer** の全量パイプラインを実行
3. 成果物を `src/souko/doc/{プロジェクト名}/` に書き込み
4. `src/souko/projects.json` に sourceUrl / branch / head / lastUpdated を登録

進捗パネルが現在のフェーズとノード毎の状態をリアルタイム表示します。途中でサーバーが止まっても、`pnpm start` で再起動し再度開始を押すとセッション状態から途中再開します。

### 4. 生成されたドキュメントを閲覧

- **ホーム**: サイドバーのドロップダウンでプロジェクト切替。切り替えると git URL 入力欄に対応するソース URL が自動入力されます。
- **架構総覧（Graph）**: トップレベルからノードをクリックして階層的に掘り下げ。エッジにホバーで関係タイプ表示。
- **ドキュメントページ**: リーフノードは Markdown。右下の AI チャットで追加質問可能（`OPENAI_API_KEY` が必要）。
- **フロー図**: Flows ビューで端々到端のビジネスフローをシーケンス図として表示。
- **検索**: サイドバーの検索ボックスで全階層からキーワード検索。

### 5. 増分更新

upstream に新しい commit がある場合、古いドキュメントを削除する必要はありません。ホームで**同じ git URL** を貼り付けて再度開始を押すだけ:

- バックエンドがまず `git fetch`
- head を比較:
  - **変更なし** → `mode: noop` で即返り、コストゼロ
  - **変更あり** → diff を計算し、**Updater Agent** が影響する `.md` / `.json` を局所的に書き換え、全量パイプラインは再実行しません

進捗パネルには `Fetching latest commits...` → `Updater agent applying diff...` と表示されます。

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

そのリポジトリを Claude Code で開けば、Agent が以下のツールを使えます:

| 種類 | ツール | 用途 |
|---|---|---|
| Query | `list_projects` | 全プロジェクト一覧 |
| Query | `get_top` / `get_graph` / `get_page` | 構造とリーフを階層的に読む |
| Query | `search_nodes` | キーワード検索 |
| Query | `list_history` / `get_history` | 履歴版の確認 |
| Mutate | `update_top` / `update_graph_meta` / `update_node` | メタデータやノードの更新 |
| Mutate | `create_node` / `delete_node` | ノード追加削除 |
| Mutate | `update_page` | リーフ md の上書き |
| Mutate | `revert` | 履歴版へ巻き戻し |

すべての mutate ツールは**楽観的ロック**付き: 書き込み時に `baseVersion` を渡し、不一致なら `VersionMismatch` が返って再読→再試行します。書き込み毎に `.history/` にスナップショットが残るので、いつでも `revert` で戻せます。

autoDoc はスリム版 `doc-drill` skill を対象リポジトリの `.claude/skills/doc-drill/` にも自動インストールし、Agent にツールの使い方を教えます。

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
- **ドキュメントを手で編集したい？** `src/souko/doc/{プロジェクト名}/` 配下の `.md` / `.json` を直接編集できます。ただし MCP の version 管理はバイパスされます。履歴スナップショットを残したいなら MCP mutate ツール経由がおすすめ。
- **Codex が profile が見つからないと言う？** `~/.codex/config.toml` に `scaffold` / `decomposer` / `writer` / `checker` / `flowanalyzer` / `updater` という名前の profile がすべて必要です。
