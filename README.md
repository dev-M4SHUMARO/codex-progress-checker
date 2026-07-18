# Codex Progress Checker for Stream Deck

Codex agent の実行状況を Stream Deck のキーで確認するプラグインです。Codex CLI の Hook が出力する状態ファイルを読み取り、作業中・ユーザー入力待ち・完了などをキーに表示します。

## 対象環境

現時点では、**Windows 上で Stream Deck を使用し、WSL 上で Codex CLI を実行する構成**を前提としています。

- Stream Deck プラグインは Windows で動作し、`%LOCALAPPDATA%\\CodexStreamDeck` の状態ファイルを読み取ります。
- Codex CLI は WSL で動作し、Hook が同じ Windows 側ディレクトリを `/mnt/c/Users/<Windowsユーザー名>/AppData/Local/CodexStreamDeck` として更新します。

macOS や Windows 上で直接 Codex CLI を実行する構成は、現在はセットアップ・動作確認の対象外です。

## 表示内容

キーには対象スレッドの位置、状態、Codex を起動したプロジェクトディレクトリ名を表示します。状態ファイルは 1 秒ごとに確認され、キーを押すと即時に再読み込みします。

| 表示 | 色 | Hook イベント |
| --- | --- | --- |
| `IDLE` | 白 | 状態ファイルがない、または `SessionStart` |
| `WORKING` | 青 | `UserPromptSubmit` / `SubagentStart` / `PostToolUse`（全ツール） |
| `WAITING` | 黄 | `PermissionRequest` / `PreToolUse`（`request_user_input`） |
| `DONE` | 緑 | `Stop` / `SubagentStop` |
| `ERROR` | 赤 | 状態ファイルの読み込み・形式に問題がある場合 |

複数の Codex セッションがある場合は、状態ファイルを最終更新時刻の新しい順に並べます。各キーの設定画面にある「新しさの順位」へ `1`（最新）、`2`（2番目に新しい）、`3`（3番目に新しい）のように指定すると、その順位の状態を表示します。キー上には `LATEST` または `RECENT #2` のように表示されます。値に上限はありません。対象のスレッドがない場合は `IDLE / No thread` と表示します。

プロジェクトディレクトリが Git リポジトリの場合は、現在のブランチ名もプロジェクト名の下に表示します。Git リポジトリでない場合や `git` コマンドが利用できない場合は、ブランチ名の表示自体を省略します。

プロジェクト名とブランチ名のフォントサイズは、設定画面の `Project Font Size` と `Branch Font Size`（各8〜24）から個別に調整できます。

## 必要なもの

- Windows 10 以降、および Stream Deck 7.1 以降
- WSL（Windows ドライブを `/mnt/c` として参照できること）
- WSL 上の Codex CLI（Hook を利用できる環境）
- WSL 上の Python 3
- Windows の `%LOCALAPPDATA%` を WSL から `/mnt/c/Users/<Windowsユーザー名>/AppData/Local` として参照できること

リポジトリからビルド・開発する場合のみ、Windows 上に Node.js と npm が必要です。Python製のHookとインストーラーをテストする場合は、WSL 上に [uv](https://docs.astral.sh/uv/) も必要です。

## セットアップ

### 配布パッケージを使う場合

配布されている `.streamDeckPlugin` をダブルクリックしてインストールし、Stream Deck のアクション一覧から `Codex Status` をキーへ配置します。

アクションの設定画面にある `Codex CLI Integration` で、Codex CLIを使用するWSLディストリビューションを選択し、`Set Up` を押してください。プラグインは次の処理を自動で行います。

- HookスクリプトをWSL側の `~/.codex/codex-progress-checker` へインストール
- 既存の `~/.codex/hooks.json` をバックアップ
- 既存設定を残したまま、このプラグインに必要なHookを追加
- Windows側の `%LOCALAPPDATA%\CodexStreamDeck` を状態ファイルの出力先として設定

セットアップ完了後にCodex CLIを再起動し、`/hooks` を開いて新しいHookを確認・信頼してください。Hookの信頼確認はCodexのセキュリティ機能であり、自動化されません。

連携を解除する場合は、同じ設定画面で `Remove` を押します。このプラグインが追加したHookとWSL側のスクリプトだけが削除されます。

### リポジトリから開発する場合

依存関係のインストール、ビルド、監視、Stream Deck CLI の操作は、Windows のリポジトリディレクトリで実行します。Codex CLI と Python 関連の操作は WSL で実行します。

#### 1. 依存関係を入れてビルドする

```bash
npm install
npm run build
```

#### 2. Stream Deck に開発用プラグインとして登録する

Stream Deck を起動した状態で、リポジトリのルートから実行します。

```bash
npx streamdeck link com.kiyoto.codex-progress-checker.sdPlugin
```

Stream Deck アプリのアクション一覧に **codex-progress-checker** が現れたら、`Codex Status` アクションを任意のキーへ配置してください。同じアクションを複数配置し、それぞれの設定画面で「新しさの順位」を `1`、`2`、`3`…と指定すると、並行作業中の複数スレッドを確認できます。

#### 3. Codex連携を設定する

配布パッケージと同様に、アクションの設定画面からWSLディストリビューションを選び、`Set Up` を押します。Codex CLIを再起動して `/hooks` からHookを信頼してください。

Codex CLIへプロンプトを送信するとキーが `WORKING` に変わります。PlanモードでCodexが質問すると `WAITING` に変わり、回答すると再び `WORKING` に戻ります。

## 動作の仕組み

```text
Codex CLI
  └─ Hook ──> ~/.codex/codex-progress-checker/streamdeck_status.py
                    └─> %LOCALAPPDATA%/CodexStreamDeck/<session>.json
                                      └─> Stream Deck plugin
                                             └─> キーの状態・プロジェクト名を描画
```

Hook スクリプトはセッション（サブエージェントはエージェント）ごとに JSON を原子的に更新します。プラグインは `%LOCALAPPDATA%/CodexStreamDeck` を読むため、Windows 側では通常次の場所に状態ファイルが作られます。

```text
C:\Users\<Windowsユーザー名>\AppData\Local\CodexStreamDeck
```

## 開発

ソース変更を監視し、ビルド後にプラグインを再起動します。

```bash
npm run watch
```

単発ビルドは以下です。

```bash
npm run build
```

### Pythonテスト

配布物に同梱するWSL/Codex側のPythonコードはpytestでテストします。Stream Deck上で動作するTypeScript/JavaScriptをpytestでテストするものではありません。

開発依存関係は [`pyproject.toml`](pyproject.toml) で宣言し、[`uv.lock`](uv.lock) でバージョンを固定しています。初回または依存関係の更新後に同期してください。

```bash
uv sync
```

テストは次のコマンドで実行します。

```bash
uv run pytest
```

現在は、Hookの追加・重複防止・バックアップ・安全な解除・不正な既存設定の保護を検証しています。

主なファイルは以下のとおりです。

| ファイル | 役割 |
| --- | --- |
| [`src/actions/codex-progress-checker.ts`](src/actions/codex-progress-checker.ts) | 状態 JSON の読み込みと Stream Deck キーの SVG 描画 |
| [`com.kiyoto.codex-progress-checker.sdPlugin/ui/codex-status.html`](com.kiyoto.codex-progress-checker.sdPlugin/ui/codex-status.html) | 表示するスレッド位置をキーごとに設定する画面 |
| [`src/codex-integration.ts`](src/codex-integration.ts) | WSLの検出とCodex連携セットアップの呼び出し |
| [`com.kiyoto.codex-progress-checker.sdPlugin/resources/codex/install_codex_integration.py`](com.kiyoto.codex-progress-checker.sdPlugin/resources/codex/install_codex_integration.py) | 既存Hookを維持したインストール・解除処理 |
| [`com.kiyoto.codex-progress-checker.sdPlugin/resources/codex/streamdeck_status.py`](com.kiyoto.codex-progress-checker.sdPlugin/resources/codex/streamdeck_status.py) | Codex Hook の入力を状態 JSON に変換 |
| [`tests/test_install_codex_integration.py`](tests/test_install_codex_integration.py) | WSL/Codex側インストーラーのpytest |
| [`tests/test_streamdeck_status.py`](tests/test_streamdeck_status.py) | 状態JSON変換スクリプトのブランチ名解決のpytest |
| [`tests/conftest.py`](tests/conftest.py) | pytestで共有する隔離済みインストーラー・状態変換スクリプトfixture |
| [`com.kiyoto.codex-progress-checker.sdPlugin/manifest.json`](com.kiyoto.codex-progress-checker.sdPlugin/manifest.json) | Stream Deck プラグインのマニフェスト |

## トラブルシュート

### キーが `IDLE` のまま変わらない

- 設定画面の `Codex CLI Integration` が `installed` になっているか確認してください。
- Codex CLIの `/hooks` で、このプラグインのHookが信頼済みになっているか確認してください。
- WSL で `~/.codex/codex-progress-checker/streamdeck_status.py` を実行できることを確認してください。
- Codex にプロンプトを送信後、`C:\Users\<Windowsユーザー名>\AppData\Local\CodexStreamDeck` に `.json` ファイルが作成されるか確認してください。

### キーが `ERROR` になる

- 状態ディレクトリの読み取り権限と JSON ファイルの内容を確認してください。
- Stream Deck のプラグインログは `com.kiyoto.codex-progress-checker.sdPlugin/logs/` に出力されます（開発時）。

### 変更が Stream Deck に反映されない

- Windows で `npm run build` を実行してから、`npx streamdeck restart com.kiyoto.codex-progress-checker` を実行してください。
- 開発中は Windows で `npm run watch` を使うと、ビルドと再起動を自動化できます。

## ライセンス

このリポジトリのコードと配布パッケージは、作者が明示的に許可した場合を除き再配布を禁止します。詳細は [LICENSE](LICENSE) を確認してください。
