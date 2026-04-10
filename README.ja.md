<p align="center">
  <h1 align="center">autoDoc</h1>
  <p align="center">
    <strong>任意のコードリポジトリを、インタラクティブなドキュメントサイトに自動変換</strong>
  </p>
  <p align="center">
    5 つの AI Agent 協調 · 反復検証 · インタラクティブアーキテクチャ図 · クラッシュリカバリ · 段階的開示
  </p>
  <p align="center">
    <a href="README.md">中文</a> | <a href="README.en.md">English</a> | <strong>日本語</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-F69220?logo=pnpm&logoColor=white" alt="pnpm">
  <a href="https://github.com/Haruhiko-Joe/autoDoc/stargazers"><img src="https://img.shields.io/github/stars/Haruhiko-Joe/autoDoc?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill">📘 コンパニオン Skill: doc-drill</a>
</p>

---

## なぜ autoDoc なのか？

DeepWiki や Google Code Wiki などの競合ツールが「一回きりのドキュメント生成」に留まるのに対し、autoDoc は**品質フィードバックループを備えたマルチ Agent ドキュメントファクトリ**です。

| | autoDoc | DeepWiki | Google Code Wiki |
|---|:---:|:---:|:---:|
| マルチ Agent 反復検証 | **5 Agent + Checker ループ** | 単発生成 | 単発生成 |
| インタラクティブ架構図 | **6 種のセマンティックエッジ + ホバー詳細** | 静的 Mermaid | 静的図 |
| 再帰的適応分解 | **Agent が深度を自律決定** | 固定階層 | フラット構造 |
| クラッシュリカバリ | **Session ID + pending ステージング** | なし | なし |
| Code Agent 統合 | **doc-drill Skill** | なし | なし |
| ハイブリッド AI バックエンド | **ロールごとに Claude/Codex 選択可** | なし | なし |

## デモ

| アーキテクチャ総覧 | サブモジュール関係図 |
|:---:|:---:|
| ![overview](fig/overview.png) | ![module](fig/module.png) |

| Markdown ドキュメントページ | AI への質問 |
|:---:|:---:|
| ![finalpage](fig/finalpage.png) | ![continuechat](fig/continuechat.png) |

| インタラクションフロー |
|:---:|
| ![interactiveflow](fig/interactiveflow.png) |

## 仕組み

```
Scaffold ──► Checker
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Decomposer ──► Checker   Decomposer ──► Checker   ...
    │                       │
    ▼                       ▼
 Writer                  Writer
    │                       │
    ▼                       ▼
 Assemble Skill ─────► Flow Analyzer ──► 完了
```

| Agent | 役割 | 検証 |
|-------|------|------|
| **Scaffold** | リポジトリ全体を分析し、トップレベルのモジュールグラフを生成 | Checker で検証 |
| **Decomposer** | モジュールをサブグラフまたはリーフページに再帰的に分割 | Checker で検証（最大 5 回リトライ） |
| **Writer** | 各リーフノードに詳細な Markdown ドキュメントを生成 | — |
| **Checker** | グラフ構造の完全性とコンテンツ品質を検証 | — |
| **Flow Analyzer** | 3–7 件の典型的なモジュール間インタラクションフローを抽出 | — |

すべての Agent は **Arranger** ステートマシンにより統合管理され、**スライディングウィンドウ型並行処理モデル**を採用——並行セッション数はフロントエンドから設定可能（デフォルト 8）。ノードごとに状態を管理し、クラッシュリカバリをサポートします。

### ハイブリッド AI バックエンド

各 Agent ロールは **Claude**（Claude Agent SDK）または **Codex**（OpenAI Codex SDK）を独立して選択可能。フロントエンドの設定パネルから個別に調整できます：

| ロール | デフォルトバックエンド |
|--------|----------------------|
| Scaffold | Claude |
| Decomposer | Claude |
| Writer | Claude |
| Checker | Codex |
| Flow Analyzer | Claude |

## 主な機能

- **インタラクティブ有向グラフ** — [AntV G6](https://g6.antv.antgroup.com/) ベース、6 種のセマンティックエッジ（呼び出し、依存、データフロー、イベント、継承、コンポジション）対応、ホバーポップオーバーで関係詳細を表示
- **段階的開示** — トップレベルアーキテクチャ概要から、ノードクリックでリーフの Markdown ドキュメントまで階層的に掘り下げ
- **インタラクションフロー図** — モジュール横断のビジネスフローを自動抽出し、参加者・ステップ・コード参照付きのシーケンス図として描画
- **モジュール検索** — サイドバーの検索ボックスで全モジュールを高速検索
- **AI チャットパネル** — フローティングチャットウィンドウでドキュメント内容に関する追加質問が可能（`OPENAI_API_KEY` が必要）
- **ダークモード** — Tokyo Night テーマ、ワンクリック切替
- **リアルタイム進捗** — ホームページからドキュメント生成の進捗をリアルタイムに確認
- **多言語対応** — 中国語（デフォルト）または英語のドキュメントサイトを生成

## プラガブルなドキュメント

各モジュールのドキュメントは自己完結型の独立ユニットです。サイト全体を再生成することなく、任意のモジュールを自由に追加・削除・差し替えできます。

- **削除** — モジュールディレクトリを削除し、親の Graph JSON から参照を除去
- **追加** — 新しいモジュールディレクトリを作成するか、ノードの status を `pending` に設定して再実行
- **差し替え** — Markdown ファイルを直接編集可能。`done` 状態のノードは上書きされない
- **増分生成** — 再実行時は未完了ノードのみ処理

## doc-drill: Code Agent ネイティブ統合

生成完了後、autoDoc は自動的に [doc-drill](https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill) Skill をターゲットリポジトリの `.claude/skills/` ディレクトリにインストールします。あらゆる Code Agent がこれを通じて：

- **段階的ブラウジング** — トップレベルモジュールから実装詳細まで段階的に掘り下げ（lazy-load でコンテキスト節約）
- **関係追跡** — 6 種のセマンティックエッジに沿ってモジュール間のコールチェーンとデータフローを追跡
- **キーワード検索** — 全ドキュメント階層を横断検索
- **ビジネスフローナビゲーション** — `flows.json` を通じてエンドツーエンドのインタラクションシナリオを理解

> これは DeepWiki（Web チャットのみ）や Google Code Wiki（Web ブラウジングのみ）にはない、Agent ネイティブな統合能力です。

## クイックスタート

### 前提条件

- Node.js >= 18
- pnpm >= 10
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) がインストール済みで正常に動作すること（公式サブスクリプション、Claude Code API、またはサードパーティ API のいずれでも可）
- （オプション）`OPENAI_API_KEY` — AI チャットパネルと Codex バックエンドを有効化

### インストール & 実行

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..

# バックエンド（ポート 3100）とフロントエンド開発サーバーを同時に起動
pnpm start
```

フロントエンドを開き、リポジトリのパスを入力し、言語と Agent バックエンドの設定を選択すると、生成が開始されます。

### 環境変数

| 変数 | 説明 | 必須 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API キー（チャットパネルと Codex バックエンド用） | チャット/Codex に必要 |
| `OPENAI_BASE_URL` | カスタム OpenAI API エンドポイント | いいえ |
| `OPENAI_MODEL` | チャットパネルで使用するモデル（デフォルト `gpt-4o`） | いいえ |

### Claude Code 内部プロキシ

ゲートウェイが内部エンドポイントモデル（例：`ep-...`）を必要とする場合、ローカル転送プロキシを起動できます：

```bash
pnpm proxy:claude:setup -- \
  --model ep-xxxxx \
  --base-url https://your-gateway.example.com/api/v1 \
  --api-key <your_token>
```

別のターミナルで：

```bash
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_API_KEY=<your_token>
claude --model "claude-opus-4-6"
```

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| バックエンド | TypeScript, [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex SDK](https://github.com/openai/codex-sdk), Zod |
| フロントエンド | Vue 3, TypeScript, AntV G6, Vite |
| AI チャット | OpenAI API（gpt-4o またはカスタムモデル） |
| モノレポ | pnpm workspaces |

## プロジェクト構成

```
autoDoc/
├── src/
│   ├── agents/              # 5 つの Agent（Claude + Codex デュアル実装）
│   │   ├── scaffold.ts      # トップレベルリポジトリ分析（Claude）
│   │   ├── decomposer.ts    # 再帰的モジュール分割（Claude）
│   │   ├── writer.ts        # Markdown ドキュメント生成（Claude）
│   │   ├── checker.ts       # グラフ構造検証（Claude）
│   │   ├── claudeflowanalyzer.ts  # インタラクションフロー分析（Claude）
│   │   ├── codex*.ts        # 各 Agent の Codex 実装
│   │   ├── instructions/    # Agent プロンプト（中国語 + 英語）
│   │   └── schemas/         # Zod 構造化出力スキーマ
│   ├── workflow/
│   │   └── arranger.ts      # パイプラインオーケストレーション ステートマシン
│   ├── skill-template/      # 生成された Claude Code Skill テンプレート
│   ├── claude-proxy.ts      # Claude API 内部プロキシ
│   └── server.ts            # API サーバー
├── scripts/
│   ├── setup-claude-proxy.sh    # プロキシデーモン起動スクリプト
│   └── unwrap-md-json.mjs       # Markdown JSON 修復ツール
├── web/                     # Vue 3 フロントエンド
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage, FlowsPage
│   │   ├── components/      # ChatPanel 等
│   │   ├── composables/     # useTheme 等
│   │   └── services/        # API クライアント
│   └── doc/                 # 生成されたドキュメント出力先
├── package.json
└── pnpm-workspace.yaml
```

## ユーティリティスクリプト

```bash
# 生成された Markdown のネスト JSON 問題をスキャン（チェックのみ）
pnpm docs:scan-md-json

# ネスト JSON 問題を自動修復
pnpm docs:fix-md-json
```

## Contributing

Issue や Pull Request を歓迎します！autoDoc が役に立ったら、ぜひ Star をお願いします。