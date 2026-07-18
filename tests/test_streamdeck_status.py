"""streamdeck_status.pyのブランチ名解決を検証する。"""

# Gitリポジトリの用意とサブプロセス呼び出しの検証に使用する。
import subprocess
from pathlib import Path
from types import ModuleType


def test_resolve_branch_returns_none_for_unborn_branch(
    status_module: ModuleType,
    tmp_path: Path,
) -> None:
    """未生成ブランチでは、ブランチ名を表示しないためNoneを返す。"""

    # Arrange: mainブランチへ明示的に初期化した、まだコミットのないGitリポジトリを用意する。
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )

    # Act: 初期化直後のリポジトリでブランチ名を解決する。
    branch = status_module.resolve_branch(str(repo))

    # Assert: 未生成ブランチは表示側で無視できるようNoneが返る。
    assert branch is None


def test_resolve_branch_returns_current_branch_name_after_first_commit(
    status_module: ModuleType,
    tmp_path: Path,
) -> None:
    """コミット済みのGitリポジトリでは、現在のブランチ名を取得できる。"""

    # Arrange: mainブランチに初回コミットを作成したGitリポジトリを用意する。
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )
    (repo / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "README.md"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Test User",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial commit",
        ],
        check=True,
        capture_output=True,
    )

    # Act: 初回コミット後のリポジトリでブランチ名を解決する。
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
