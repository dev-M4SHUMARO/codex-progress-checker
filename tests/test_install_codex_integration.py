"""Codex連携インストーラーが既存設定を安全に扱うことを検証する。"""

# テスト結果のJSON確認と一時ファイル操作に使用する。
import json
from pathlib import Path
from types import ModuleType

# 例外発生を検証するためにpytestを利用する。
import pytest


def test_install_is_idempotent_and_preserves_existing_hooks(
    installer: ModuleType,
    tmp_path: Path,
) -> None:
    """再インストールしても既存Hookを維持し、自分のHookを重複させない。"""

    # Arrange: 既存Hookとメタデータが入った利用者のhooks.jsonを用意する。
    installer.HOOKS_PATH.parent.mkdir(parents=True)
    existing = {
        "description": "Keep this metadata",
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "python3 /existing/stop.py",
                        }
                    ]
                }
            ]
        },
    }
    installer.HOOKS_PATH.write_text(json.dumps(existing), encoding="utf-8")
    status_script = tmp_path / "bundled_status.py"
    status_script.write_text("print('{}')\n", encoding="utf-8")
    output_dir = tmp_path / "windows-local-app-data" / "CodexStreamDeck"

    # Act: 初回セットアップと更新時の再セットアップを連続して実行する。
    installer.install(status_script, output_dir)
    installer.install(status_script, output_dir)

    # Assert: 既存値、追加Hook数、出力先、世代別バックアップを確認する。
    document = json.loads(installer.HOOKS_PATH.read_text(encoding="utf-8"))
    assert document["description"] == "Keep this metadata"
    assert (
        document["hooks"]["Stop"][0]["hooks"][0]["command"]
        == "python3 /existing/stop.py"
    )
    assert count_our_hooks(installer, document) == 7
    assert installer.status()["installed"] is True
    assert json.loads(installer.CONFIG_PATH.read_text(encoding="utf-8"))[
        "output_dir"
    ] == str(output_dir)
    backups = list(installer.HOOKS_PATH.parent.glob("hooks.json.*.bak"))
    assert len(backups) == 2
    assert any(
        json.loads(path.read_text(encoding="utf-8")) == existing for path in backups
    )


def test_uninstall_removes_only_our_hooks(
    installer: ModuleType,
    tmp_path: Path,
) -> None:
    """解除時に他のHookを残し、本プラグインのファイルとHookだけを削除する。"""

    # Arrange: 本プラグインを導入後、別製品を模したHookを同じイベントへ追加する。
    status_script = tmp_path / "bundled_status.py"
    status_script.write_text("print('{}')\n", encoding="utf-8")
    installer.install(status_script, tmp_path / "output")
    document = json.loads(installer.HOOKS_PATH.read_text(encoding="utf-8"))
    document["hooks"]["Stop"].append(
        {"hooks": [{"type": "command", "command": "keep-me"}]}
    )
    installer.write_json_atomic(installer.HOOKS_PATH, document)

    # Act: Codex連携の解除処理を実行する。
    installer.uninstall()

    # Assert: 他製品のHookは残り、本プラグインの追加物だけが消える。
    updated = json.loads(installer.HOOKS_PATH.read_text(encoding="utf-8"))
    assert count_our_hooks(installer, updated) == 0
    assert updated["hooks"]["Stop"][0]["hooks"][0]["command"] == "keep-me"
    assert not installer.INSTALL_DIRECTORY.exists()


def test_invalid_existing_hooks_are_not_overwritten(
    installer: ModuleType,
    tmp_path: Path,
) -> None:
    """既存hooks.jsonの構造が不正なら、失敗させて元ファイルを保護する。"""

    # Arrange: Stopイベントが配列ではない、上書きしてはいけない設定を用意する。
    installer.HOOKS_PATH.parent.mkdir(parents=True)
    original = '{"hooks":{"Stop":"invalid"}}\n'
    installer.HOOKS_PATH.write_text(original, encoding="utf-8")
    status_script = tmp_path / "bundled_status.py"
    status_script.write_text("print('{}')\n", encoding="utf-8")

    # Act: 不正な既存設定へのインストールがValueErrorになることを捕捉する。
    with pytest.raises(ValueError):
        installer.install(status_script, tmp_path / "output")

    # Assert: 元の文字列が完全に維持され、途中生成物も残らないことを確認する。
    assert installer.HOOKS_PATH.read_text(encoding="utf-8") == original
    assert not installer.INSTALL_DIRECTORY.exists()


def test_post_tool_use_hook_matches_all_tools(
    installer: ModuleType,
    tmp_path: Path,
) -> None:
    """PostToolUseは全ツールで発火させ、質問回答後にwaitingから復帰できるようにする。"""

    # Arrange: 追加設定のない状態からCodex連携をインストールする。
    status_script = tmp_path / "bundled_status.py"
    status_script.write_text("print('{}')\n", encoding="utf-8")

    # Act: インストーラーが利用者のhooks.jsonへHookを書き込む。
    installer.install(status_script, tmp_path / "output")

    # Assert: PostToolUseはmatcher無しで全ツールを拾い、PreToolUseは質問ツールだけへ絞る。
    document = json.loads(installer.HOOKS_PATH.read_text(encoding="utf-8"))
    post_group = our_group(installer, document, "PostToolUse")
    assert "matcher" not in post_group
    pre_group = our_group(installer, document, "PreToolUse")
    assert pre_group.get("matcher") == "^request_user_input$"


def our_group(installer: ModuleType, document: dict, event: str) -> dict:
    """指定イベント配下で本プラグインが追加したhandlerを含むgroupを返す。"""

    # 他製品のgroupと混在しても、commandの一致で自分のgroupだけを特定する。
    for group in document["hooks"][event]:
        if any(installer.is_our_handler(handler) for handler in group["hooks"]):
            return group
    raise AssertionError(f"our handler not found for event '{event}'")


def count_our_hooks(installer: ModuleType, document: dict) -> int:
    """テスト対象が所有するHook handlerだけを数える。"""

    # 全イベントを走査し、インストーラー自身の識別規則を検証にも再利用する。
    return sum(
        installer.is_our_handler(handler)
        for groups in document.get("hooks", {}).values()
        for group in groups
        for handler in group.get("hooks", [])
    )
