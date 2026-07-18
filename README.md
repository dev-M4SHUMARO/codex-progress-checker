# Codex Progress Checker for Stream Deck

Codex agent の実行状況を Stream Deck のキーで確認する開発用プラグインです。Codex CLI の Hook が出力する状態ファイルを読み取り、作業中・ユーザー入力待ち・完了などをキーに表示します。

## 対象環境

現時点では、**Windows 上で Stream Deck を使用し、WSL 上で Codex CLI を実行する構成**を前提としています。

- Stream Deck プラグインは Windows で動作し、`%LOCALAPPDATA%\\CodexStreamDeck` の状態ファイルを読み取ります。
- Codex CLI は WSL で動作し、Hook が同じ Windows 側ディレクトリを `/mnt/c/Users/<Windowsユーザー名>/AppData/Local/CodexStreamDeck` として更新します。

macOS や Windows 上で直接 Codex CLI を実行する構成は、現在はセットアップ・動作確認の対象外です。

## 表示内容

キーには状態と、Codex を起動したプロジェクトディレクトリ名を表示します。状態ファイルは 1 秒ごとに確認され、キーを押すと即時に再読み込みします。

| 表示 | 色 | Hook イベント |
| --- | --- | --- |
| `IDLE` | 白 | 状態ファイルがない、または `SessionStart` |
| `WORKING` | 青 | `UserPromptSubmit` / `SubagentStart` / `PostToolUse`（`request_user_input`） |
| `WAITING` | 黄 | `PermissionRequest` / `PreToolUse`（`request_user_input`） |
| `DONE` | 緑 | `Stop` / `SubagentStop` |
| `ERROR` | 赤 | 状態ファイルの読み込み・形式に問題がある場合 |

複数の Codex セッションがある場合は、最終更新時刻がもっとも新しい状態を表示します。同じアクションを複数のキーに置いた場合は、すべて同じ状態に更新されます。

## 必要なもの

- Windows 10 以降、および Stream Deck 7.1 以降
- WSL（Windows ドライブを `/mnt/c` として参照できること）
- WSL 上の Codex CLI（Hook を利用できる環境）
- WSL 上の Python 3
- [Bun](https://bun.sh/) 1.3 以降（プラグインをビルド・開発する場合）
- Windows の `%LOCALAPPDATA%` を WSL から `/mnt/c/Users/<Windowsユーザー名>/AppData/Local` として参照できること

## セットアップ

以下のコマンドは、特記がない限り WSL のリポジトリディレクトリで実行します。

### 1. 依存関係を入れてビルドする

```bash
bun install
bun run build
```

### 2. Stream Deck に開発用プラグインとして登録する

Stream Deck を起動した状態で、リポジトリのルートから実行します。

```bash
bunx streamdeck link com.kiyoto.codex-progress-checker.sdPlugin
```

Stream Deck アプリのアクション一覧に **codex-progress-checker** が現れたら、`CodexProgressChecker` アクションを任意のキーへ配置してください。

### 3. Codex Hook を設定する

状態を書き込むスクリプトを Codex の設定ディレクトリにコピーします。

```bash
cp codex_settings/streamdeck_status.py ~/.codex/streamdeck_status.py
chmod +x ~/.codex/streamdeck_status.py
```

`~/.codex/streamdeck_status.py` を開き、`OUTPUT_DIR` の Windows ユーザー名を自分の環境に合わせます。

```python
OUTPUT_DIR = Path("/mnt/c/Users/<Windowsユーザー名>/AppData/Local/CodexStreamDeck")
```

次に、[`codex_settings/hooks.json`](codex_settings/hooks.json) の `command` を、実際にコピーしたスクリプトのパスに合わせて修正してください。

```json
"command": "python3 /home/<WSLユーザー名>/.codex/streamdeck_status.py"
```

その内容を、利用中の Codex 設定の `hooks` に追加します。すでに `hooks` を設定済みの場合は、既存設定を残してイベントごとの配列へ追加してください。対象イベントは次の 7 つです。

- `UserPromptSubmit`
- `PreToolUse`（`request_user_input` のみ）
- `PostToolUse`（`request_user_input` のみ）
- `PermissionRequest`
- `Stop`
- `SubagentStart`
- `SubagentStop`

Codex CLI を新しく起動し、プロンプトを送信するとキーが `WORKING` に変わります。
Plan モードで Codex が質問すると `WAITING` に変わり、回答すると再び `WORKING` に戻ります。

## 動作の仕組み

```text
Codex CLI
  └─ Hook ──> ~/.codex/streamdeck_status.py
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
bun run watch
```

単発ビルドは以下です。

```bash
bun run build
```

主なファイルは以下のとおりです。

| ファイル | 役割 |
| --- | --- |
| [`src/actions/codex-progress-checker.ts`](src/actions/codex-progress-checker.ts) | 状態 JSON の読み込みと Stream Deck キーの SVG 描画 |
| [`codex_settings/streamdeck_status.py`](codex_settings/streamdeck_status.py) | Codex Hook の入力を状態 JSON に変換 |
| [`codex_settings/hooks.json`](codex_settings/hooks.json) | Codex Hook 設定のひな形 |
| [`com.kiyoto.codex-progress-checker.sdPlugin/manifest.json`](com.kiyoto.codex-progress-checker.sdPlugin/manifest.json) | Stream Deck プラグインのマニフェスト |

## トラブルシュート

### キーが `IDLE` のまま変わらない

- Codex の Hook 設定が有効か、`command` のスクリプトパスが正しいか確認してください。
- WSL で `~/.codex/streamdeck_status.py` を実行でき、`OUTPUT_DIR` が Windows 側のユーザーディレクトリを指していることを確認してください。
- Codex にプロンプトを送信後、`C:\Users\<Windowsユーザー名>\AppData\Local\CodexStreamDeck` に `.json` ファイルが作成されるか確認してください。

### キーが `ERROR` になる

- 状態ディレクトリの読み取り権限と JSON ファイルの内容を確認してください。
- Stream Deck のプラグインログは `com.kiyoto.codex-progress-checker.sdPlugin/logs/` に出力されます（開発時）。

### 変更が Stream Deck に反映されない

- `bun run build` を実行してから、`bunx streamdeck restart com.kiyoto.codex-progress-checker` を実行してください。
- 開発中は `bun run watch` を使うと、ビルドと再起動を自動化できます。

## ライセンス

このリポジトリにライセンスファイルが追加されるまで、利用条件はリポジトリの管理者に確認してください。
