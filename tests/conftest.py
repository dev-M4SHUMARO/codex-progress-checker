"""Codex連携インストーラーのpytest共通fixtureを定義する。"""

# インストーラーはPythonパッケージではないため、ファイルから動的に読み込む。
import importlib.util
import os
from pathlib import Path
from types import ModuleType

# テストごとに隔離したHOMEとmockのライフサイクルをpytestへ管理させる。
import pytest
from pytest_mock import MockerFixture

# 配布物に実際に含まれるインストーラーをテスト対象として固定する。
INSTALLER_PATH = (
    Path(__file__).parents[1]
    / "com.kiyoto.codex-progress-checker.sdPlugin"
    / "resources"
    / "codex"
    / "install_codex_integration.py"
)


@pytest.fixture
def installer(tmp_path: Path, mocker: MockerFixture) -> ModuleType:
    """実ユーザーの~/.codexを触らないインストーラーモジュールを返す。"""

    # モジュール定数の初期化前に、インストール先HOMEを一時領域へ差し替える。
    mocker.patch.dict(
        os.environ,
        {"CODEX_PROGRESS_CHECKER_HOME": str(tmp_path)},
    )

    # テストごとに別名で読み込み、パス定数を一時HOMEから再評価する。
    spec = importlib.util.spec_from_file_location(
        f"codex_progress_checker_installer_{tmp_path.name}",
        INSTALLER_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Codex integration installer could not be loaded")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module
