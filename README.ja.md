# autoDoc

[English](README.md) | [中文](README.zh-CN.md) | **[日本語](README.ja.md)**

autoDoc を任意のコードリポジトリに向けるだけで、インタラクティブなドキュメントサイトを自動生成します。

autoDoc は 4 つの Claude AI エージェントによるパイプラインでコードベースを分析・モジュール分解し、グラフベースのナビゲーション可能なドキュメントサイトを生成します。段階的開示（Progressive Disclosure）設計により、トップレベルのアーキテクチャ概要から任意のモジュールの詳細な Markdown ドキュメントまで、階層的に掘り下げることができます。

## 仕組み

```
Scaffold ──► Checker
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Decomposer ──► Checker   Decomposer ──► Checker   ...
                │                       │
                ▼                       ▼
  Writer ──► Checker       Writer ──► Checker
                │                       │
                ▼                       ▼
              完了                     完了
```

1. **Scaffold** — リポジトリ全体を分析し、トップレベルのモジュールグラフを生成、Checker で検証
2. **Decomposer** — 各モジュールをサブグラフまたはリーフページに再帰的に分割、Checker で検証
3. **Writer** — 各リーフノードに対して詳細な Markdown ドキュメントを生成、Checker で検証
4. **Checker** — 各エージェント完了後に実行、グラフ構造またはコンテンツ品質を検証（最大 3 回リトライ）

すべてのエージェントは **Arranger** ステートマシンによって統合管理され、**スライディングウィンドウ型の並行処理モデル**を採用——並行 Claude セッション数はフロントエンドから設定可能（デフォルト 8）。ノードごとに状態を管理し、クラッシュリカバリをサポートします。

## 生成されるドキュメントサイト

- **インタラクティブな有向グラフ**（[AntV G6](https://g6.antv.antgroup.com/) ベース）で、モジュール間の関係を型付きエッジ（呼び出し、依存、データフロー、イベント、継承、コンポジション）で表示
- **段階的開示** — グラフノードをクリックしてサブグラフに入るか、リーフの Markdown ドキュメントに到達
- **チャットパネル** — エージェントセッションをフォークして、ドキュメントページ上で質問が可能
- **リアルタイム進捗** — ホームページからドキュメント生成の進捗をリアルタイムで確認

## プラガブルなドキュメント

各モジュールのドキュメントは自己完結型の独立ユニットです——Graph JSON と Markdown ファイルを含むディレクトリ単位で管理されます。サイト全体を再生成することなく、任意のモジュールを自由に追加・削除・差し替えできます。

- **削除** — モジュールディレクトリを削除し、親の Graph JSON から参照を除去するだけで、他のドキュメントには影響なし
- **追加** — 新しいモジュールディレクトリ（Graph JSON + Markdown）を作成するか、ノードの status を `pending` に設定して Arranger を再実行すれば自動生成
- **差し替え** — Markdown ファイルを直接編集・上書き可能。ノードの status が `done` であれば、Arranger は上書きしない
- **増分生成** — 再実行時、未完了のノードのみ処理し、完了済みモジュールはすべてスキップ

> **注意：** エージェントのセッション履歴はローカルにのみ保存されます。生成された `doc/` ファイルを他者に共有した場合、チャット機能（エージェントセッションのフォークに基づく）は利用できません。グラフナビゲーションと Markdown レンダリングは正常に動作します。

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| バックエンド | TypeScript, [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk), Zod |
| フロントエンド | Vue 3, TypeScript, AntV G6, Vite |
| モノレポ | pnpm workspaces |

## クイックスタート

### 前提条件

- Node.js >= 18
- pnpm >= 10
- Anthropic API キー（`ANTHROPIC_API_KEY` 環境変数に設定）

### インストール

```bash
git clone https://github.com/YanboQiao/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
```

### 実行

```bash
# バックエンド（ポート 3100）とフロントエンド開発サーバーを同時に起動
pnpm start

# または個別に起動：
pnpm dev              # バックエンドのみ
cd web && pnpm dev    # フロントエンドのみ（/api を :3100 にプロキシ）
```

フロントエンドを開き、リポジトリのパスを入力すると、autoDoc がドキュメント生成を開始します。

### ビルド

```bash
cd web && pnpm build
```

## プロジェクト構成

```
autoDoc/
├── src/
│   ├── agents/              # 4 つの Claude エージェント
│   │   ├── scaffold.ts      # トップレベルのリポジトリ分析
│   │   ├── decomposer.ts    # 再帰的モジュール分割
│   │   ├── writer.ts        # Markdown ドキュメント生成
│   │   ├── checker.ts       # 品質検証
│   │   ├── instructions/    # エージェントプロンプト（中国語）
│   │   └── schemas/         # Zod 構造化出力スキーマ
│   ├── workflow/
│   │   └── arranger.ts      # パイプラインオーケストレーション ステートマシン
│   └── server.ts            # API サーバー
├── web/                     # Vue 3 フロントエンド
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage
│   │   └── services/        # API クライアント
│   └── doc/                 # 生成されたドキュメント出力先
├── package.json
└── pnpm-workspace.yaml
```

## ライセンス

Apache-2.0
