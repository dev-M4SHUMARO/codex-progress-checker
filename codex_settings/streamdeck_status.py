#!/usr/bin/env python3

import hashlib
import json
import sys
import time
from pathlib import Path

# Windowsユーザー名に合わせて変更
OUTPUT_DIR = Path("/mnt/c/Users/k2002/AppData/Local/CodexStreamDeck")

STATUS_MAP = {
    "SessionStart": "idle",
    "UserPromptSubmit": "working",
    "SubagentStart": "working",
    "PermissionRequest": "waiting",
    "Stop": "completed",
    "SubagentStop": "completed",
}


def resolve_state(event: str, tool_name=None) -> str:
    if tool_name == "request_user_input":
        if event == "PreToolUse":
            return "waiting"
        if event == "PostToolUse":
            return "working"

    return STATUS_MAP.get(event, "unknown")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        print("{}")
        return 0

    event = payload.get("hook_event_name", "unknown")
    tool_name = payload.get("tool_name")
    session_id = payload.get("session_id", "unknown")
    agent_id = payload.get("agent_id")

    identity = agent_id or session_id
    filename = hashlib.sha256(identity.encode()).hexdigest()[:16] + ".json"

    status = {
        "id": identity,
        "session_id": session_id,
        "agent_id": agent_id,
        "event": event,
        "state": resolve_state(event, tool_name),
        "cwd": payload.get("cwd"),
        "updated_at": time.time(),
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    target = OUTPUT_DIR / filename
    temporary = target.with_suffix(".tmp")

    temporary.write_text(
        json.dumps(status, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary.replace(target)

    # Codex Hookへの正常応答
    print("{}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
