"""streamdeck_status.pyのブランチ名解決を検証する。"""

# Gitリポジトリの用意とサブプロセス呼び出しの検証に使用する。
import subprocess
from pathlib import Path
from types import ModuleType


def test_resolve_branch_returns_current_branch_name(
    status_module: ModuleType,
    tmp_path: Path,
) -> None:
    """Gitリポジトリのcwdからは、現在のブランチ名を取得できる。"""

    # Arrange: mainブランチへ明示的に初期化した最小のGitリポジトリを用意する。
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )

    # Act: 初期化直後のリポジトリでブランチ名を解決する。
    branch = status_module.resolve_branch(str(repo))

    # Assert: 初期化時に指定したブランチ名がそのまま返る。
    assert branch == "main"


def test_resolve_branch_returns_none_outside_git_repository(
    status_module: ModuleType,
    tmp_path: Path,
) -> None:
    """Gitリポジトリでないcwdでは、例外を出さずNoneを返す。"""

    # Arrange: Git管理下にない空のディレクトリを用意する。
    plain_directory = tmp_path / "not-a-repo"
    plain_directory.mkdir()

    # Act: リポジトリでないディレクトリでブランチ名を解決する。
    branch = status_module.resolve_branch(str(plain_directory))

    # Assert: 表示側で無視できるようNoneが返る。
    assert branch is None


def test_resolve_branch_returns_none_for_missing_cwd(
    status_module: ModuleType,
) -> None:
    """cwdがNoneや空文字の場合は、Gitを呼び出さずNoneを返す。"""

    # Act & Assert: 型が不正な入力でも例外にならず、Noneへ正規化される。
    assert status_module.resolve_branch(None) is None
    assert status_module.resolve_branch("") is None
