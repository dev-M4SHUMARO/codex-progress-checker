#!/usr/bin/env python3
"""Codex Hookの入力をStream Deckが読む状態JSONへ変換する。"""

# セッションごとのファイル名生成、設定読込、入出力、更新時刻の記録に使用する。
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

# ブランチ取得コマンドがリポジトリ外や巨大リポジトリで固まらないための上限秒数。
GIT_BRANCH_TIMEOUT_SECONDS = 3

# インストーラーが生成した共有ディレクトリ設定を、スクリプト自身の隣から読む。
CONFIG_PATH = Path(__file__).with_name("config.json")

# Codexのライフサイクルイベントを、Stream Deckで表示する状態へ正規化する。
STATUS_MAP = {
    "SessionStart": "idle",
    "UserPromptSubmit": "working",
    "SubagentStart": "working",
    "PermissionRequest": "waiting",
    "Stop": "completed",
    "SubagentStop": "completed",
}


def resolve_output_dir() -> Path:
    """明示指定を優先し、なければインストール時の出力先設定を返す。"""

    # 詳細な利用者は環境変数だけで出力先を一時的に差し替えられるようにする。
    override = os.environ.get("CODEX_STREAMDECK_OUTPUT_DIR")
    if override:
        return Path(override).expanduser()

    # 通常利用ではセットアップ画面が生成したconfig.jsonを利用する。
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    output_dir = config.get("output_dir")
    if not isinstance(output_dir, str) or not output_dir:
        raise ValueError("output_dir is missing from config.json")

    # チルダを許容し、最終的に書き込み可能なPathとして呼び出し元へ返す。
    return Path(output_dir).expanduser()


def resolve_state(event: str, tool_name=None) -> str:
    """Hookイベントとツール名からStream Deck表示用の状態を決める。"""

    # 質問ツールは呼出前が回答待ち、呼出後が作業再開なのでイベントだけでは判定しない。
    if tool_name == "request_user_input":
        if event == "PreToolUse":
            return "waiting"
        if event == "PostToolUse":
            return "working"

    # 質問ツール以外はライフサイクルイベントの固定対応表から状態を返す。
    return STATUS_MAP.get(event, "unknown")


def resolve_branch(cwd) -> Optional[str]:
    """cwdがGitリポジトリなら現在のブランチ名を返し、それ以外はNoneを返す。"""

    # cwdが無い、または文字列でない場合はGitを呼び出さない。
    if not isinstance(cwd, str) or not cwd:
        return None

    try:
        # detached HEADではブランチ名の代わりに"HEAD"が返るため、名前とみなさない。
        result = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=GIT_BRANCH_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        # gitが未インストール、またはコマンドが応答しない場合は表示を諦める。
        return None

    if result.returncode != 0:
        # Gitリポジトリでない、または権限がない場合はここに来る。
        return None

    branch = result.stdout.strip()
    return branch if branch and branch != "HEAD" else None


def main() -> int:
    """標準入力のHook payloadを読み、セッション単位の状態ファイルを更新する。"""

    # Hook失敗でCodex本体を止めないため、入力や設定が不正なら正常応答だけを返す。
    try:
        payload = json.load(sys.stdin)
        output_dir = resolve_output_dir()
    except (json.JSONDecodeError, OSError, ValueError, TypeError):
        print("{}")
        return 0

    # 状態判定とセッション識別に必要な共通Hookフィールドを取り出す。
    event = payload.get("hook_event_name", "unknown")
    tool_name = payload.get("tool_name")
    session_id = payload.get("session_id", "unknown")
    agent_id = payload.get("agent_id")

    # サブエージェントは独立表示し、それ以外はセッション単位で同じファイルを更新する。
    identity = agent_id or session_id
    filename = hashlib.sha256(identity.encode()).hexdigest()[:16] + ".json"
    cwd = payload.get("cwd")

    # Stream Deck側が状態、プロジェクト名、更新順を判断できる最小情報を保存する。
    status = {
        "id": identity,
        "session_id": session_id,
        "agent_id": agent_id,
        "event": event,
        "state": resolve_state(event, tool_name),
        "cwd": cwd,
        # Gitリポジトリでない場合はNoneのままとし、Stream Deck側で非表示にする。
        "branch": resolve_branch(cwd),
        "updated_at": time.time(),
    }

    # 初回実行でも書き込めるよう共有ディレクトリを遅延作成する。
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / filename
    temporary = target.with_suffix(".tmp")
    # 読み取り途中のJSONをStream Deckへ見せないよう、一時ファイルから原子的に置換する。
    temporary.write_text(
        json.dumps(status, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary.replace(target)

    # 空のJSON応答でHookが正常終了したことをCodexへ通知する。
    print("{}")
    return 0


if __name__ == "__main__":
    # CLIとして呼ばれた場合だけHook処理を開始し、終了コードをOSへ返す。
    raise SystemExit(main())
