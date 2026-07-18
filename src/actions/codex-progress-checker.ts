import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import streamDeck, {
  action,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

type CodexState =
  | "idle"
  | "working"
  | "waiting"
  | "completed"
  | "error";

type StatusSnapshot = {
  state: CodexState;
  project: string;
  updatedAt: number;
  event?: string;
};

/**
 * JSONファイルを確認する間隔。
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * WSL側では以下と同じディレクトリ。
 *
 * /mnt/c/Users/<ユーザー名>/AppData/Local/CodexStreamDeck
 */
const STATUS_DIRECTORY = path.join(
  process.env.LOCALAPPDATA ??
    path.join(
      process.env.USERPROFILE ?? "",
      "AppData",
      "Local",
    ),
  "CodexStreamDeck",
);

const STATE_COLORS: Record<CodexState, string> = {
  idle: "#eeeeee",
  working: "#2088ff",
  waiting: "#ffbf00",
  completed: "#22aa66",
  error: "#dd3344",
};

const STATE_TEXT_COLORS: Record<CodexState, string> = {
  idle: "#222222",
  working: "#ffffff",
  waiting: "#222222",
  completed: "#ffffff",
  error: "#ffffff",
};

const STATE_LABELS: Record<CodexState, string> = {
  idle: "IDLE",
  working: "WORKING",
  waiting: "WAITING",
  completed: "DONE",
  error: "ERROR",
};

/**
 * stateがJSONにない場合、Codex Hookイベントから状態を判断する。
 */
const EVENT_STATE_MAP: Record<string, CodexState> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  SubagentStart: "working",
  PermissionRequest: "waiting",
  Stop: "completed",
  SubagentStop: "completed",
};

const IDLE_STATUS: StatusSnapshot = {
  state: "idle",
  project: "Codex",
  updatedAt: 0,
};

const ERROR_STATUS: StatusSnapshot = {
  state: "error",
  project: "Read error",
  updatedAt: 0,
};

/**
 * このUUIDはmanifest.jsonのActions[].UUIDと一致させること。
 */
@action({
  UUID: "com.kiyoto.codex-progress-checker.status",
})
export class CodexStatusAction extends SingletonAction {
  private pollingTimer:
    | ReturnType<typeof setInterval>
    | undefined;

  /**
   * 前回のポーリングが終わっていない状態で、
   * 次のポーリングが重複実行されることを防ぐ。
   */
  private polling = false;

  /**
   * このアクションが現在表示されているキーの数。
   */
  private visibleActionCount = 0;

  /**
   * 同じ内容でsetImageを何度も呼ばないために使う。
   */
  private lastBroadcastSignature: string | undefined;

  /**
   * 同じエラーを毎秒ログ出力しないために使う。
   */
  private lastLoggedError: string | undefined;

  /**
   * Stream Deck上にキーが表示されたときに呼ばれる。
   */
  override async onWillAppear(
    ev: WillAppearEvent,
  ): Promise<void> {
    this.visibleActionCount += 1;
    this.startPolling();

    const status = await this.loadLatestStatusSafely();

    await this.renderAction(
      ev.action,
      status,
    );

    this.lastBroadcastSignature =
      this.createSignature(status);
  }

  /**
   * ページ移動などでキーが表示されなくなったときに呼ばれる。
   */
  override onWillDisappear(
    _ev: WillDisappearEvent,
  ): void {
    this.visibleActionCount = Math.max(
      0,
      this.visibleActionCount - 1,
    );

    if (this.visibleActionCount === 0) {
      this.stopPolling();
    }
  }

  /**
   * キーを押した場合、即座に再読み込みする。
   */
  override async onKeyDown(
    ev: KeyDownEvent,
  ): Promise<void> {
    const status = await this.loadLatestStatusSafely();

    await this.renderAction(
      ev.action,
      status,
    );

    this.lastBroadcastSignature =
      this.createSignature(status);
  }

  /**
   * JSONファイルの定期確認を開始する。
   */
  private startPolling(): void {
    if (this.pollingTimer !== undefined) {
      return;
    }

    this.pollingTimer = setInterval(() => {
      void this.pollAndRender();
    }, POLL_INTERVAL_MS);
  }

  /**
   * キーが表示されていない場合は定期確認を停止する。
   */
  private stopPolling(): void {
    if (this.pollingTimer === undefined) {
      return;
    }

    clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
  }

  /**
   * 最新状態を読み、変更があった場合だけキーを更新する。
   */
  private async pollAndRender(): Promise<void> {
    if (
      this.polling ||
      this.visibleActionCount === 0
    ) {
      return;
    }

    this.polling = true;

    try {
      const status =
        await this.loadLatestStatusSafely();

      const signature =
        this.createSignature(status);

      if (
        signature ===
        this.lastBroadcastSignature
      ) {
        return;
      }

      this.lastBroadcastSignature = signature;

      const updates: Promise<void>[] = [];

      /*
       * 同じCodex Statusアクションが複数キーに配置されている場合、
       * 表示中の全キーを更新する。
       */
      this.actions.forEach((visibleAction) => {
        updates.push(
          this.renderAction(
            visibleAction,
            status,
          ),
        );
      });

      await Promise.all(updates);
    } finally {
      this.polling = false;
    }
  }

  /**
   * ファイル読み込み失敗時でもプラグインを落とさず、
   * ERROR表示へ切り替える。
   */
  private async loadLatestStatusSafely():
    Promise<StatusSnapshot> {
    try {
      const status =
        await this.loadLatestStatus();

      this.lastLoggedError = undefined;

      return status;
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);

      if (message !== this.lastLoggedError) {
        streamDeck.logger.error(
          `Codex status directory could not be read: ${message}`,
        );

        this.lastLoggedError = message;
      }

      return ERROR_STATUS;
    }
  }

  /**
   * ディレクトリ内のJSONを読み、
   * updated_atが最も新しいものを返す。
   */
  private async loadLatestStatus():
    Promise<StatusSnapshot> {
    let entries;

    try {
      entries = await readdir(
        STATUS_DIRECTORY,
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      /*
       * まだCodexが一度もJSONを書いていない場合は、
       * ディレクトリ自体が存在しない。
       */
      if (
        isNodeError(error) &&
        error.code === "ENOENT"
      ) {
        return IDLE_STATUS;
      }

      throw error;
    }

    const jsonFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json"),
    );

    if (jsonFiles.length === 0) {
      return IDLE_STATUS;
    }

    const statuses = (
      await Promise.all(
        jsonFiles.map((entry) =>
          this.readStatusFile(
            path.join(
              STATUS_DIRECTORY,
              entry.name,
            ),
          ),
        ),
      )
    ).filter(
      (
        status,
      ): status is StatusSnapshot =>
        status !== null,
    );

    if (statuses.length === 0) {
      return {
        state: "error",
        project: "Invalid JSON",
        updatedAt: 0,
      };
    }

    statuses.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt,
    );

    return statuses[0];
  }

  /**
   * 1つのJSONファイルを読み込む。
   */
  private async readStatusFile(
    filePath: string,
  ): Promise<StatusSnapshot | null> {
    try {
      const content = await readFile(
        filePath,
        "utf-8",
      );

      const parsed: unknown =
        JSON.parse(content);

      if (!isRecord(parsed)) {
        return null;
      }

      const updatedAt = parseTimestamp(
        parsed.updated_at,
      );

      if (updatedAt === null) {
        return null;
      }

      const event =
        typeof parsed.event === "string"
          ? parsed.event
          : undefined;

      const state = normalizeState(
        parsed.state,
        event,
      );

      const project =
        getProjectName(parsed);

      return {
        state,
        project,
        updatedAt,
        event,
      };
    } catch {
      /*
       * 壊れたJSONが1つあっても、
       * 他の正常なJSONは引き続き利用する。
       */
      return null;
    }
  }

  /**
   * 状態に応じたSVGを生成してStream Deckへ送る。
   */
  private async renderAction(
    actionInstance: WillAppearEvent["action"],
    status: StatusSnapshot,
  ): Promise<void> {
    const svg = createStatusSvg(status);

    await Promise.all([
      /*
       * manifest.json側のタイトルがSVGの上に
       * 重ならないように空文字にする。
       */
      actionInstance.setTitle(""),

      actionInstance.setImage(
        `data:image/svg+xml,${encodeURIComponent(svg)}`,
      ),
    ]);
  }

  /**
   * 表示内容が変わったかを判定するための値。
   */
  private createSignature(
    status: StatusSnapshot,
  ): string {
    return [
      status.state,
      status.project,
      status.updatedAt,
      status.event ?? "",
    ].join("|");
  }
}

/**
 * JSONのstate、またはイベント名から状態を決める。
 */
function normalizeState(
  value: unknown,
  event?: string,
): CodexState {
  if (
    value === "idle" ||
    value === "working" ||
    value === "waiting" ||
    value === "completed" ||
    value === "error"
  ) {
    return value;
  }

  if (
    event !== undefined &&
    EVENT_STATE_MAP[event] !== undefined
  ) {
    return EVENT_STATE_MAP[event];
  }

  return "error";
}

/**
 * Pythonのtime.time()は秒、
 * JavaScriptのDate.now()はミリ秒なので統一する。
 */
function parseTimestamp(
  value: unknown,
): number | null {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp < 10_000_000_000
    ? timestamp * 1_000
    : timestamp;
}

/**
 * cwdの最後のディレクトリ名をプロジェクト名として使う。
 *
 * 例:
 * /home/user/projects/acrochatai
 * → acrochatai
 */
function getProjectName(
  status: Record<string, unknown>,
): string {
  const cwd =
    typeof status.cwd === "string"
      ? status.cwd
      : undefined;

  const id =
    typeof status.id === "string"
      ? status.id
      : undefined;

  if (cwd !== undefined) {
    const segments = cwd
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);

    return truncate(
      segments.at(-1) ?? "Codex",
      15,
    );
  }

  return truncate(
    id ?? "Codex",
    15,
  );
}

/**
 * Stream Deckキーに表示するSVG。
 */
function createStatusSvg(
  status: StatusSnapshot,
): string {
  const backgroundColor =
    STATE_COLORS[status.state];

  const textColor =
    STATE_TEXT_COLORS[status.state];

  const stateLabel = escapeXml(
    STATE_LABELS[status.state],
  );

  const projectLabel = escapeXml(
    status.project,
  );

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="144"
     height="144"
     viewBox="0 0 144 144">
  <rect
    width="144"
    height="144"
    rx="18"
    fill="${backgroundColor}"
  />

  <text
    x="72"
    y="66"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="20"
    font-weight="700"
    fill="${textColor}">
    ${stateLabel}
  </text>

  <text
    x="72"
    y="94"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="13"
    fill="${textColor}">
    ${projectLabel}
  </text>
</svg>`.trim();
}

function truncate(
  value: string,
  maxLength: number,
): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(
    0,
    maxLength - 1,
  )}…`;
}

/**
 * cwdやIDにXMLの特殊文字が含まれていても
 * SVGが壊れないようにする。
 */
function escapeXml(
  value: string,
): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNodeError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error
  );
}