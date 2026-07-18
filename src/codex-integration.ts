import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

/** Property Inspectorから受け付ける操作だけを表す。 */
type IntegrationRequest = {
  type: "codexIntegration";
  operation: "discover" | "status" | "install" | "uninstall";
  distribution?: string;
};

/** Pythonインストーラーが返す導入状態を表す。 */
type IntegrationStatus = {
  installed: boolean;
  hooksPath: string;
  installDirectory: string;
};

/** WSLやPythonが応答しない場合にUIを待たせ続けないための上限。 */
const COMMAND_TIMEOUT_MS = 15_000;

/** バンドル後もresourcesを解決できるよう、実行中のbin/plugin.jsからルートを求める。 */
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** WSL側の設定を安全に編集する同梱インストーラーのWindowsパス。 */
const installerPath = path.join(
  pluginRoot,
  "resources",
  "codex",
  "install_codex_integration.py",
);

/** インストーラーが利用者のCodex領域へコピーするHook本体のWindowsパス。 */
const statusScriptPath = path.join(
  pluginRoot,
  "resources",
  "codex",
  "streamdeck_status.py",
);

/** PATHの差異を避けるため、Windows標準位置のwsl.exeを直接使用する。 */
const wslExecutable = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "wsl.exe",
);

/**
 * Property Inspectorから送られたCodex連携操作を処理する。
 */
export function registerCodexIntegration(): void {
  // Property Inspectorからのメッセージをプラグイン全体で一度だけ購読する。
  streamDeck.ui.onSendToPlugin(async (ev) => {
    // 他アクションのメッセージを誤処理しないよう、型と操作名を最初に限定する。
    if (!isIntegrationRequest(ev.payload)) {
      return;
    }

    // 型検証後のpayloadだけを、以降のWSL操作へ渡す。
    const request = ev.payload;

    // OS操作の失敗をプラグイン停止へ波及させず、UIへ結果として返す。
    try {
      // 初期表示では変更を行わず、選択肢となるWSL一覧だけを返す。
      if (request.operation === "discover") {
        const distributions = await listDistributions();
        await streamDeck.ui.sendToPropertyInspector({
          type: "codexIntegrationResult",
          operation: request.operation,
          ok: true,
          distributions,
        });
        return;
      }

      // 書込み系操作の前に、選択値が現在存在するディストリビューションか再確認する。
      const distribution = await requireDistribution(
        request.distribution,
      );
      const status = await runInstaller(
        distribution,
        request.operation,
      );

      // Pythonが返した最新状態を、要求した操作名と一緒にUIへ返す。
      await streamDeck.ui.sendToPropertyInspector({
        type: "codexIntegrationResult",
        operation: request.operation,
        ok: true,
        distribution,
        status,
      });
    } catch (error) {
      // 利用者向け表示と診断ログの両方へ同じ原因を残す。
      const message = getErrorMessage(error);
      streamDeck.logger.error(
        `Codex integration ${request.operation} failed: ${message}`,
      );

      await streamDeck.ui.sendToPropertyInspector({
        type: "codexIntegrationResult",
        operation: request.operation,
        ok: false,
        message,
      });
    }
  });
}

/**
 * 任意のJSON値が本機能向けの許可済みリクエストかを判定する。
 */
function isIntegrationRequest(
  value: unknown,
): value is IntegrationRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // オブジェクト化した後も、type・operation・distributionの型をすべて検証する。
  const request = value as Record<string, unknown>;
  return (
    request.type === "codexIntegration" &&
    (request.operation === "discover" ||
      request.operation === "status" ||
      request.operation === "install" ||
      request.operation === "uninstall") &&
    (request.distribution === undefined ||
      typeof request.distribution === "string")
  );
}

/**
 * UIの選択値が実在するWSLディストリビューションであることを保証する。
 */
async function requireDistribution(
  requested: string | undefined,
): Promise<string> {
  // 古いUI状態や改変payloadを使わないよう、操作直前の一覧を取得する。
  const distributions = await listDistributions();

  if (requested === undefined || !distributions.includes(requested)) {
    throw new Error("Select an installed WSL distribution.");
  }

  return requested;
}

/**
 * wsl.exeから利用可能なディストリビューション名を重複なしで取得する。
 */
async function listDistributions(): Promise<string[]> {
  // ローカライズされた説明文を解析せず、名前だけを返すquiet形式を利用する。
  const output = await runProcess(wslExecutable, [
    "--list",
    "--quiet",
  ]);

  // Windows由来の改行や空行を除き、selectへそのまま渡せる名前に整える。
  const distributions = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);

  if (distributions.length === 0) {
    throw new Error("No WSL distribution was found.");
  }

  // 同名が返った場合でもUIに重複表示しないようSetで一意化する。
  return [...new Set(distributions)];
}

/**
 * 選択したWSLでPythonインストーラーを実行し、構造化された状態を返す。
 */
async function runInstaller(
  distribution: string,
  operation: "status" | "install" | "uninstall",
): Promise<IntegrationStatus> {
  // Windows配下の同梱スクリプトをWSLのPythonが読めるパスへ変換する。
  const wslInstallerPath = await toWslPath(
    distribution,
    installerPath,
  );
  // シェル文字列を組み立てず引数配列を使い、名前やパスの注入・引用問題を避ける。
  const args = [
    "--distribution",
    distribution,
    "--exec",
    "python3",
    wslInstallerPath,
    operation,
  ];

  // installだけはコピー元スクリプトとWindows共有出力先を追加で渡す。
  if (operation === "install") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.length === 0) {
      throw new Error("Windows LOCALAPPDATA could not be resolved.");
    }

    // 独立した2パスは並列変換し、設定画面の待ち時間を短くする。
    const [wslStatusScriptPath, wslLocalAppData] = await Promise.all([
      toWslPath(distribution, statusScriptPath),
      toWslPath(distribution, localAppData),
    ]);

    args.push(
      "--status-script",
      wslStatusScriptPath,
      "--output-dir",
      `${wslLocalAppData.replace(/\/$/u, "")}/CodexStreamDeck`,
    );
  }

  // 検証済みの引数だけでWSL上のPythonを起動する。
  const output = await runProcess(wslExecutable, args);

  // UIへ曖昧な文字列を渡さないよう、Python応答がJSONであることを検証する。
  try {
    return JSON.parse(output) as IntegrationStatus;
  } catch {
    throw new Error(`Unexpected installer response: ${output}`);
  }
}

/**
 * 特定ディストリビューションのwslpathでWindowsパスをLinux形式へ変換する。
 */
async function toWslPath(
  distribution: string,
  windowsPath: string,
): Promise<string> {
  // 複数WSL間でマウント構成が違う可能性があるため、対象内で変換する。
  return (
    await runProcess(wslExecutable, [
      "--distribution",
      distribution,
      "--exec",
      "wslpath",
      "-u",
      windowsPath,
    ])
  ).trim();
}

/**
 * 外部プロセスをタイムアウト付きで実行し、文字コードを正規化して返す。
 */
function runProcess(
  executable: string,
  args: string[],
): Promise<string> {
  // callback APIをPromise化し、上位処理から順序立ててawaitできるようにする。
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "buffer",
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // 成否にかかわらずstdout/stderrを同じ規則で読み取る。
        const output = decodeOutput(stdout).trim();
        const errorOutput = decodeOutput(stderr).trim();

        // PythonやWSLの具体的なstderrを優先し、UIで対処可能な原因を表示する。
        if (error !== null) {
          reject(
            new Error(
              errorOutput || output || error.message,
            ),
          );
          return;
        }

        // 正常終了時は余分な空白を除いた標準出力だけを呼び出し元へ返す。
        resolve(output);
      },
    );
  });
}

/**
 * wsl.exeは環境によってUTF-16LEを返すため、NUL文字を見て判定する。
 */
function decodeOutput(value: string | Buffer): string {
  // 型定義や環境により文字列で来た場合もNULだけは除去する。
  if (typeof value === "string") {
    return value.replaceAll("\0", "");
  }

  // NULの有無でwsl.exe特有のUTF-16LEと通常のUTF-8を判別する。
  const encoding = value.includes(0) ? "utf16le" : "utf8";
  return value.toString(encoding).replaceAll("\0", "");
}

/**
 * unknown例外をログとUIへ安全に渡せる文字列へ変換する。
 */
function getErrorMessage(error: unknown): string {
  // Errorのmessageを優先し、文字列throwなども情報を失わないようString化する。
  return error instanceof Error ? error.message : String(error);
}
