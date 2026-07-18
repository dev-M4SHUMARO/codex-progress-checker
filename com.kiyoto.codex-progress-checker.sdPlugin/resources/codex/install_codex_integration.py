#!/usr/bin/env python3
"""Stream Deck設定画面からCodex Hookを安全に導入・解除する。"""

# 引数処理、JSON編集、原子的書込、バックアップ、ファイル配置に使用する。
import argparse
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 通常は実ユーザーHOMEを使い、テスト時だけ専用環境変数で一時HOMEへ隔離する。
USER_HOME = Path(os.environ.get("CODEX_PROGRESS_CHECKER_HOME", Path.home()))

# 本プラグインが所有するファイルと、Codexが読み込む利用者Hook設定の場所を固定する。
INSTALL_DIRECTORY = USER_HOME / ".codex" / "codex-progress-checker"
HOOKS_PATH = USER_HOME / ".codex" / "hooks.json"
INSTALLED_SCRIPT = INSTALL_DIRECTORY / "streamdeck_status.py"
CONFIG_PATH = INSTALL_DIRECTORY / "config.json"
HOOK_COMMAND = 'python3 "$HOME/.codex/codex-progress-checker/streamdeck_status.py"'
STATUS_MESSAGE = "Updating Stream Deck Codex status"

# 表示状態の更新に必要なイベントと、必要なイベントだけへ絞るmatcherを一元管理する。
# PreToolUseは質問ツールの開始だけをwaitingとして拾えばよいのでmatcherで絞る。
# 一方PostToolUseは全ツールを対象にする。request_user_inputへ限定すると、
# 回答後のイベントでツール名が一致せずwaitingから復帰できないことがあるため。
HOOK_DEFINITIONS: dict[str, dict[str, Any]] = {
    "UserPromptSubmit": {},
    "PreToolUse": {"matcher": "^request_user_input$"},
    "PostToolUse": {},
    "PermissionRequest": {},
    "Stop": {},
    "SubagentStart": {},
    "SubagentStop": {},
}


def hook_handler() -> dict[str, Any]:
    """各イベントへ追加する共通command handlerを新しい辞書で返す。"""

    # 同じ辞書を共有すると編集が別イベントへ波及するため、呼出ごとに生成する。
    return {
        "type": "command",
        "command": HOOK_COMMAND,
        "timeout": 5,
        "statusMessage": STATUS_MESSAGE,
    }


def is_our_handler(value: Any) -> bool:
    """commandの完全一致により本プラグイン所有のhandlerだけを識別する。"""

    # 解除時に他製品のHookを消さないため、曖昧な部分一致は使用しない。
    return isinstance(value, dict) and value.get("command") == HOOK_COMMAND


def remove_our_hooks(document: dict[str, Any]) -> bool:
    """文書から本プラグインのhandlerだけを除き、変更有無を返す。"""

    # hooks自体がない文書は有効なので、何も変更せず終了する。
    hooks = document.get("hooks")
    if hooks is None:
        return False
    if not isinstance(hooks, dict):
        raise ValueError("hooks.json field 'hooks' must be an object")

    # バックアップと書込みが必要かを呼び出し元で判断できるよう変更を記録する。
    changed = False
    for event, groups in list(hooks.items()):
        if not isinstance(groups, list):
            raise ValueError(f"hooks.json event '{event}' must be an array")

        # 各matcher group内の他handlerを残し、空になったgroupだけを後で除去する。
        remaining_groups = []
        for group in groups:
            if not isinstance(group, dict):
                raise ValueError(f"hooks.json event '{event}' contains an invalid group")

            handlers = group.get("hooks")
            if not isinstance(handlers, list):
                raise ValueError(f"hooks.json event '{event}' group must contain a hooks array")

            # commandが一致する自分のhandlerだけをフィルタし、他の設定は順序も維持する。
            remaining_handlers = [item for item in handlers if not is_our_handler(item)]
            if len(remaining_handlers) != len(handlers):
                changed = True

            if remaining_handlers:
                updated_group = dict(group)
                updated_group["hooks"] = remaining_handlers
                remaining_groups.append(updated_group)

        # イベント配列まで空になった場合は空要素を残さず、既存イベントはそのまま戻す。
        if remaining_groups:
            hooks[event] = remaining_groups
        else:
            hooks.pop(event, None)

    # 解除操作が冪等になるよう、実際に削除した場合だけTrueを返す。
    return changed


def add_our_hooks(document: dict[str, Any]) -> None:
    """検証済み文書へ必要な7イベントのHook groupを追加する。"""

    # 既存Hookを維持しながら追記できるよう、hooksオブジェクトだけを必要時に作る。
    hooks = document.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("hooks.json field 'hooks' must be an object")

    # matcherを含むイベント定義を複製し、共通handlerを各イベントへ独立して追加する。
    for event, definition in HOOK_DEFINITIONS.items():
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError(f"hooks.json event '{event}' must be an array")

        group = dict(definition)
        group["hooks"] = [hook_handler()]
        groups.append(group)


def read_hooks() -> dict[str, Any]:
    """既存hooks.jsonを読み、未作成なら空の有効文書を返す。"""

    # 初回セットアップでは設定ファイルがなくても通常ケースとして扱う。
    if not HOOKS_PATH.exists():
        return {"hooks": {}}

    # JSONやトップレベル構造が不正なら上書きせず、利用者へエラーを返す。
    document = json.loads(HOOKS_PATH.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("hooks.json must contain a JSON object")
    return document


def write_json_atomic(path: Path, value: Any) -> None:
    """同一ディレクトリの一時ファイル経由でJSONを原子的に置換する。"""

    # 初回導入でも保存でき、replaceが同一ファイルシステム内になるよう親を先に作る。
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)

    # 書込み完了後だけ本番パスへ置換し、失敗時は一時ファイルを必ず片付ける。
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def backup_hooks() -> None:
    """既存hooks.jsonを上書き前の内容と時刻が分かる名前で退避する。"""

    # 新規作成時にはバックアップ元がないため、不要な空ファイルを作らない。
    if not HOOKS_PATH.exists():
        return

    # 連続セットアップでも世代を失わないようマイクロ秒を含むUTC時刻を使う。
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_path = HOOKS_PATH.with_name(f"hooks.json.codex-progress-checker.{timestamp}.bak")
    shutil.copy2(HOOKS_PATH, backup_path)


def install(status_script: Path, output_dir: Path) -> None:
    """状態スクリプトと設定を配置し、必要なHookを冪等に登録する。"""

    # 配布リソースが欠けている場合は既存設定へ触れる前に明示的に失敗する。
    if not status_script.is_file():
        raise ValueError(f"Bundled status script was not found: {status_script}")

    # 古い自分の定義を一度除去してから追加し、更新を繰り返しても重複させない。
    document = read_hooks()
    remove_our_hooks(document)
    add_our_hooks(document)

    # Hookが安定したパスを参照できるよう、配布物から利用者のCodex領域へコピーする。
    INSTALL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    shutil.copy2(status_script, INSTALLED_SCRIPT)
    INSTALLED_SCRIPT.chmod(0o755)
    write_json_atomic(CONFIG_PATH, {"output_dir": str(output_dir)})

    # 利用者が復旧できるバックアップを作ってから、検証済み文書を原子的に保存する。
    backup_hooks()
    write_json_atomic(HOOKS_PATH, document)


def uninstall() -> None:
    """他の設定を保持しながら本プラグインのHookと配置物を削除する。"""

    # command完全一致のhandlerだけを除去し、未導入状態での再実行も成功させる。
    document = read_hooks()
    changed = remove_our_hooks(document)

    # 実際に設定が変わる場合だけバックアップと書込みを行う。
    if changed:
        backup_hooks()
        write_json_atomic(HOOKS_PATH, document)

    # Hookから参照されなくなった後で、本プラグイン専用ディレクトリだけを削除する。
    if INSTALL_DIRECTORY.exists():
        shutil.rmtree(INSTALL_DIRECTORY)


def status() -> dict[str, Any]:
    """スクリプト、設定、全Hookが揃っているかをUI向けに返す。"""

    # 設定ファイル内に存在する自分のhandler数を全イベントから集計する。
    document = read_hooks()
    hooks = document.get("hooks", {})
    installed_hook_count = 0

    if isinstance(hooks, dict):
        for groups in hooks.values():
            if not isinstance(groups, list):
                continue
            for group in groups:
                if not isinstance(group, dict):
                    continue
                handlers = group.get("hooks", [])
                if isinstance(handlers, list):
                    installed_hook_count += sum(is_our_handler(item) for item in handlers)

    # 一部だけの導入をinstalledと誤表示しないよう、ファイルと7Hookをすべて確認する。
    return {
        "installed": (
            INSTALLED_SCRIPT.is_file()
            and CONFIG_PATH.is_file()
            and installed_hook_count == len(HOOK_DEFINITIONS)
        ),
        "hooksPath": str(HOOKS_PATH),
        "installDirectory": str(INSTALL_DIRECTORY),
    }


def parse_args() -> argparse.Namespace:
    """操作名とinstall時に必要な配布元・出力先引数を検証する。"""

    # UIバックエンドから渡す値を限定し、意図しない操作を受け付けない。
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("status", "install", "uninstall"))
    parser.add_argument("--status-script", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    # installだけはコピー元と共有出力先が必須なので、処理開始前に不足を拒否する。
    if args.operation == "install" and (args.status_script is None or args.output_dir is None):
        parser.error("install requires --status-script and --output-dir")

    return args


def main() -> int:
    """要求された操作を実行し、最新状態をJSONでStream Deckへ返す。"""

    # 検証済み引数に応じ、状態確認では変更せず、導入・解除だけを書き込む。
    args = parse_args()

    if args.operation == "install":
        install(args.status_script, args.output_dir)
    elif args.operation == "uninstall":
        uninstall()

    # Property Inspectorが結果を表示できるよう、共通形式の状態JSONを標準出力へ返す。
    print(json.dumps(status(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    # WSLからスクリプトとして起動された場合だけ操作を実行する。
    raise SystemExit(main())
