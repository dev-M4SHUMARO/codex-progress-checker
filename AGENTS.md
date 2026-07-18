# AGENTS.md

このリポジトリで Coding Agent が作業するときの共通ルールです。特に指示がない限り、リポジトリ全体に適用します。
Claude Code で作業する場合も、このファイルを一次情報として参照してください。

## 基本方針

- 変更は小さく保ち、単一責務の単位で実装・整理してください。
- 既存の構成、命名、スタイルを優先し、不要な大規模リファクタリングは避けてください。
- 仕様や挙動を変える場合は、README など利用者向けドキュメントも必要に応じて更新してください。
- 依存関係を追加する場合は、目的と代替案を検討し、最小限にしてください。
- 生成物や一時ファイルをコミットしないでください。

## 開発コマンド

このプロジェクトでは Bun を優先して使います。

- 依存関係のインストール: `bun install`
- ビルド: `bun run build`
- ウォッチ開発: `bun run watch`
- TypeScript/JavaScript のスクリプト実行: `bun <file>`
- パッケージ実行: `bunx <package> <command>`

`npm` / `yarn` / `pnpm` / `npx` を使う必要がある場合は、理由を明確にしてください。

### Bun 利用方針

- `node <file>` や `ts-node <file>` ではなく `bun <file>` を使ってください。
- `jest` や `vitest` ではなく `bun test` を使ってください。
- `webpack` や `esbuild` ではなく、必要に応じて `bun build <file.html|file.ts|file.css>` を使ってください。
- `npm install` / `yarn install` / `pnpm install` ではなく `bun install` を使ってください。
- `npm run <script>` / `yarn run <script>` / `pnpm run <script>` ではなく `bun run <script>` を使ってください。
- `npx <package> <command>` ではなく `bunx <package> <command>` を使ってください。
- Bun は `.env` を自動で読み込むため、`dotenv` は使わないでください。

### Bun API の優先

- `express` ではなく、WebSockets、HTTPS、routes をサポートする `Bun.serve()` を使ってください。
- SQLite には `better-sqlite3` ではなく `bun:sqlite` を使ってください。
- Redis には `ioredis` ではなく `Bun.redis` を使ってください。
- Postgres には `pg` や `postgres.js` ではなく `Bun.sql` を使ってください。
- WebSocket には `ws` ではなく、組み込みの `WebSocket` を使ってください。
- `node:fs` の `readFile` / `writeFile` より `Bun.file` を優先してください。
- `execa` ではなく ``Bun.$`command` `` を優先してください。
- Bun API の詳細が必要な場合は、`node_modules/bun-types/docs/**/*.mdx` を参照してください。

### フロントエンド

- `vite` ではなく、`Bun.serve()` と HTML imports の利用を優先してください。
- HTML imports は React、CSS、Tailwind をサポートしています。
- HTML ファイルは `.tsx`、`.jsx`、`.js` ファイルを直接 import でき、Bun の bundler が transpile と bundle を行います。
- 開発時に HMR が必要な場合は、`bun --hot ./index.ts` のように実行してください。

## コード設計

- 関数・クラス・モジュールは単一責務を意識して分割してください。
- UI 描画、状態取得、データ変換、I/O は可能な範囲で分離してください。
- 副作用を持つ処理は境界に寄せ、純粋なロジックをテストしやすい形にしてください。
- マジックナンバーや重複した文字列は、意味の分かる定数へ切り出してください。
- エラーは握りつぶさず、利用者またはログから原因を追える形にしてください。

## TypeScript / Stream Deck プラグイン

- 型を明示し、`any` の使用は避けてください。必要な場合は理由が分かるようにしてください。
- Stream Deck SDK のイベント処理では、非同期処理の失敗がログに残るようにしてください。
- キー表示の SVG や UI 文言を変更する場合は、状態ごとの表示崩れがないか確認してください。
- ビルド確認には `bun run build` を使ってください。

## テスト方針

### 共通

- 変更したロジックには、可能な限り自動テストを追加または更新してください。
- テストケース（テスト関数）は Arrange / Act / Assert（AAA）ブロックが読み取れる構成にしてください。fixture はセットアップ（Arrange）そのものなので、AAA ラベルは付けないでください。
- 共通のセットアップ、テストデータ、fixture はテストファイル内に重複させず、適切な共有場所へ切り出してください。
- 外部サービス、ファイルシステム、時刻、環境変数などの副作用は、境界で差し替えられるようにしてください。
- 実装の詳細ではなく、利用者から見える振る舞いを中心に検証してください。

### Python テスト

Python のテストを追加・変更する場合は、以下を守ってください。

- テストランナーは `pytest` を使ってください。
- モックはできるだけ深い境界（外部 I/O や外部 API に近い場所）で行い、テスト対象の中核ロジックを過度にモックしないでください。
- 複数テストで使う fixture は `conftest.py` に切り出してください。
- 一時ファイルやディレクトリには `tmp_path` など pytest 標準 fixture を使ってください。
- 例外系・境界値・正常系を分けて、テスト名から意図が分かるようにしてください。

### TypeScript / JavaScript テスト

TypeScript または JavaScript のテストを追加・変更する場合は、Bun のテスト機能を優先してください。

- テストランナーは原則 `bun test` を使ってください。
- 外部 I/O や SDK 依存は薄いアダプターに分け、アダプター境界でスタブ化してください。
- スナップショットに頼りすぎず、重要な状態・文言・分岐を明示的に検証してください。

## レビュー前チェック

変更内容に応じて、少なくとも以下を確認してください。

- `bun run build`
- Python テストを触った場合は `pytest`
- TypeScript/JavaScript テストを触った場合は `bun test`
- ドキュメントのみの変更では、必要なコマンド確認が不要な理由を PR 本文に書いてください。

## PR メッセージ

PR には以下を含めてください。

- 変更内容の要約
- 実行したテスト・チェック
- 未実行のテストがある場合は、その理由
