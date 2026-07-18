import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
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
  branch?: string;
  updatedAt: number;
  event?: string;
};

type CodexStatusSettings = {
  threadNumber?: number | string;
  projectFontSize?: number | string;
  branchFontSize?: number | string;
};

/**
 * JSONファイルを確認する間隔。
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * プロジェクト名テキストのフォントサイズの初期値と範囲。
 */
const DEFAULT_PROJECT_FONT_SIZE = 13;
const MIN_PROJECT_FONT_SIZE = 8;
const MAX_PROJECT_FONT_SIZE = 24;

/**
 * ブランチ名テキストのフォントサイズの初期値と範囲。
 */
const DEFAULT_BRANCH_FONT_SIZE = 11;
const MIN_BRANCH_FONT_SIZE = 8;
const MAX_BRANCH_FONT_SIZE = 24;

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
  PostToolUse: "working",
  Stop: "completed",
  SubagentStop: "completed",
};

const ERROR_STATUS: StatusSnapshot = {
  state: "error",
  project: "Read error",
  updatedAt: 0,
};

@action({
  UUID: "com.kiyoto.codex-progress-checker.status",
})
export class CodexStatusAction extends SingletonAction<CodexStatusSettings> {
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
  private readonly lastSignatures = new Map<string, string>();

  /**
   * アクションごとのスレッド番号を、配列用の0始まりで保持する。
   */
  private readonly offsets = new Map<string, number>();

  /**
   * アクションごとのプロジェクト名フォントサイズを保持する。
   */
  private readonly projectFontSizes = new Map<string, number>();

  /**
   * アクションごとのブランチ名フォントサイズを保持する。
   */
  private readonly branchFontSizes = new Map<string, number>();

  /**
   * 同じエラーを毎秒ログ出力しないために使う。
   */
  private lastLoggedError: string | undefined;

  /**
   * Stream Deck上にキーが表示されたときに呼ばれる。
   */
  override async onWillAppear(
    ev: WillAppearEvent<CodexStatusSettings>,
  ): Promise<void> {
    this.visibleActionCount += 1;
    this.startPolling();

    const offset = normalizeThreadNumber(
      ev.payload.settings.threadNumber,
    ) - 1;
    this.offsets.set(ev.action.id, offset);

    const projectFontSize = normalizeProjectFontSize(
      ev.payload.settings.projectFontSize,
    );
    this.projectFontSizes.set(ev.action.id, projectFontSize);

    const branchFontSize = normalizeBranchFontSize(
      ev.payload.settings.branchFontSize,
    );
    this.branchFontSizes.set(ev.action.id, branchFontSize);

    const statuses = await this.loadStatusesSafely();
    const status = selectStatus(statuses, offset);

    await this.renderAction(
      ev.action,
      status,
      offset,
      projectFontSize,
      branchFontSize,
    );

    this.lastSignatures.set(
      ev.action.id,
      this.createSignature(
        status,
        offset,
        projectFontSize,
        branchFontSize,
      ),
    );
  }

  /**
   * ページ移動などでキーが表示されなくなったときに呼ばれる。
   */
  override onWillDisappear(
    ev: WillDisappearEvent<CodexStatusSettings>,
  ): void {
    this.visibleActionCount = Math.max(
      0,
      this.visibleActionCount - 1,
    );
    this.offsets.delete(ev.action.id);
    this.projectFontSizes.delete(ev.action.id);
    this.branchFontSizes.delete(ev.action.id);
    this.lastSignatures.delete(ev.action.id);

    if (this.visibleActionCount === 0) {
      this.stopPolling();
    }
  }

  /**
   * キーを押した場合、即座に再読み込みする。
   */
  override async onKeyDown(
    ev: KeyDownEvent<CodexStatusSettings>,
  ): Promise<void> {
    const offset = normalizeThreadNumber(
      ev.payload.settings.threadNumber,
    ) - 1;
    this.offsets.set(ev.action.id, offset);

    const projectFontSize = normalizeProjectFontSize(
      ev.payload.settings.projectFontSize,
    );
    this.projectFontSizes.set(ev.action.id, projectFontSize);

    const branchFontSize = normalizeBranchFontSize(
      ev.payload.settings.branchFontSize,
    );
    this.branchFontSizes.set(ev.action.id, branchFontSize);

    const statuses = await this.loadStatusesSafely();
    const status = selectStatus(statuses, offset);

    await this.renderAction(
      ev.action,
      status,
      offset,
      projectFontSize,
      branchFontSize,
    );

    this.lastSignatures.set(
      ev.action.id,
      this.createSignature(
        status,
        offset,
        projectFontSize,
        branchFontSize,
      ),
    );
  }

  /**
   * 設定画面で値が変わったキーだけを即座に更新する。
   */
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<CodexStatusSettings>,
  ): Promise<void> {
    const offset = normalizeThreadNumber(
      ev.payload.settings.threadNumber,
    ) - 1;
    this.offsets.set(ev.action.id, offset);

    const projectFontSize = normalizeProjectFontSize(
      ev.payload.settings.projectFontSize,
    );
    this.projectFontSizes.set(ev.action.id, projectFontSize);

    const branchFontSize = normalizeBranchFontSize(
      ev.payload.settings.branchFontSize,
    );
    this.branchFontSizes.set(ev.action.id, branchFontSize);

    const statuses = await this.loadStatusesSafely();
    const status = selectStatus(statuses, offset);

    await this.renderAction(
      ev.action,
      status,
      offset,
      projectFontSize,
      branchFontSize,
    );
    this.lastSignatures.set(
      ev.action.id,
      this.createSignature(
        status,
        offset,
        projectFontSize,
        branchFontSize,
      ),
    );
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
      const statuses =
        await this.loadStatusesSafely();

      const updates: Promise<void>[] = [];

      /*
       * 同じCodex Statusアクションが複数キーに配置されている場合、
       * 表示中の全キーを更新する。
       */
      this.actions.forEach((visibleAction) => {
        const offset =
          this.offsets.get(visibleAction.id) ?? 0;
        const projectFontSize =
          this.projectFontSizes.get(visibleAction.id) ??
          DEFAULT_PROJECT_FONT_SIZE;
        const branchFontSize =
          this.branchFontSizes.get(visibleAction.id) ??
          DEFAULT_BRANCH_FONT_SIZE;
        const status = selectStatus(statuses, offset);
        const signature =
          this.createSignature(
            status,
            offset,
            projectFontSize,
            branchFontSize,
          );

        if (
          signature ===
          this.lastSignatures.get(visibleAction.id)
        ) {
          return;
        }

        this.lastSignatures.set(
          visibleAction.id,
          signature,
        );
        updates.push(
          this.renderAction(
            visibleAction,
            status,
            offset,
            projectFontSize,
            branchFontSize,
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
  private async loadStatusesSafely():
    Promise<StatusSnapshot[]> {
    try {
      const statuses =
        await this.loadStatuses();

      this.lastLoggedError = undefined;

      return statuses;
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

      return [ERROR_STATUS];
    }
  }

  /**
   * ディレクトリ内のJSONを読み、
   * 状態をupdated_atの新しい順で返す。
   */
  private async loadStatuses():
    Promise<StatusSnapshot[]> {
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
        return [];
      }

      throw error;
    }

    const jsonFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json"),
    );

    if (jsonFiles.length === 0) {
      return [];
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
      return [{
        state: "error",
        project: "Invalid JSON",
        updatedAt: 0,
      }];
    }

    statuses.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt,
    );

    return statuses;
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

      const branch =
        typeof parsed.branch === "string" && parsed.branch.length > 0
          ? parsed.branch
          : undefined;

      return {
        state,
        project,
        branch,
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
    actionInstance: WillAppearEvent<CodexStatusSettings>["action"],
    status: StatusSnapshot,
    offset: number,
    projectFontSize: number,
    branchFontSize: number,
  ): Promise<void> {
    const svg = createStatusSvg(
      status,
      offset,
      projectFontSize,
      branchFontSize,
    );

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
    offset: number,
    projectFontSize: number,
    branchFontSize: number,
  ): string {
    return [
      offset,
      status.state,
      status.project,
      status.branch ?? "",
      status.updatedAt,
      status.event ?? "",
      projectFontSize,
      branchFontSize,
    ].join("|");
  }
}

/**
 * 0を最新として、設定された個数前の状態を選ぶ。
 */
function selectStatus(
  statuses: StatusSnapshot[],
  offset: number,
): StatusSnapshot {
  const readError = statuses.find(
    (status) =>
      status.state === "error" &&
      status.updatedAt === 0,
  );

  if (readError !== undefined) {
    return readError;
  }

  return statuses[offset] ?? {
    state: "idle",
    project: offset === 0 ? "Codex" : "No thread",
    updatedAt: 0,
  };
}

function normalizeThreadNumber(value: unknown): number {
  const threadNumber =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 1;

  if (!Number.isFinite(threadNumber) || threadNumber < 1) {
    return 1;
  }

  return Math.min(
    Math.floor(threadNumber),
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * プロジェクト名テキストのフォントサイズを、表示可能な範囲へ丸める。
 */
function normalizeProjectFontSize(value: unknown): number {
  const fontSize =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : DEFAULT_PROJECT_FONT_SIZE;

  if (!Number.isFinite(fontSize)) {
    return DEFAULT_PROJECT_FONT_SIZE;
  }

  return Math.min(
    MAX_PROJECT_FONT_SIZE,
    Math.max(MIN_PROJECT_FONT_SIZE, Math.round(fontSize)),
  );
}

/**
 * ブランチ名テキストのフォントサイズを、表示可能な範囲へ丸める。
 */
function normalizeBranchFontSize(value: unknown): number {
  const fontSize =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : DEFAULT_BRANCH_FONT_SIZE;

  if (!Number.isFinite(fontSize)) {
    return DEFAULT_BRANCH_FONT_SIZE;
  }

  return Math.min(
    MAX_BRANCH_FONT_SIZE,
    Math.max(MIN_BRANCH_FONT_SIZE, Math.round(fontSize)),
  );
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

  /*
   * 表示文字数はcreateStatusSvgがフォントサイズに応じて調整するため、
   * ここでは異常に長い値だけを抑える。
   */
  if (cwd !== undefined) {
    const segments = cwd
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);

    return truncate(
      segments.at(-1) ?? "Codex",
      60,
    );
  }

  return truncate(
    id ?? "Codex",
    60,
  );
}

/**
 * 与えられたフォントサイズでキー幅に収まる、おおよその最大文字数。
 */
function maxLabelLength(fontSize: number): number {
  const usableWidth = 128;
  const estimatedCharWidth = fontSize * 0.6;

  return Math.max(
    4,
    Math.floor(usableWidth / estimatedCharWidth),
  );
}

/**
 * Stream Deckキーに表示するSVG。
 */
function createStatusSvg(
  status: StatusSnapshot,
  offset: number,
  projectFontSize: number,
  branchFontSize: number,
): string {
  const backgroundColor =
    STATE_COLORS[status.state];

  const textColor =
    STATE_TEXT_COLORS[status.state];

  const stateLabel = escapeXml(
    STATE_LABELS[status.state],
  );

  const projectLabel = escapeXml(
    truncate(status.project, maxLabelLength(projectFontSize)),
  );

  const branchLabel =
    status.branch !== undefined
      ? escapeXml(
          truncate(status.branch, maxLabelLength(branchFontSize)),
        )
      : undefined;

  const stateY = branchLabel !== undefined ? 65 : 70;
  const projectY = branchLabel !== undefined ? 94 : 99;
  const branchY = 123;

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
    y="27"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="12"
    font-weight="700"
    fill="${textColor}"
    opacity="0.8">
    ${offset === 0 ? "LATEST" : `RECENT #${offset + 1}`}
  </text>

  <text
    x="72"
    y="${stateY}"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="20"
    font-weight="700"
    fill="${textColor}">
    ${stateLabel}
  </text>

  <text
    x="72"
    y="${projectY}"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="${projectFontSize}"
    fill="${textColor}">
    ${projectLabel}
  </text>
${
    branchLabel !== undefined
      ? `
  <text
    x="72"
    y="${branchY}"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="${branchFontSize}"
    fill="${textColor}"
    opacity="0.75">
    ${branchLabel}
  </text>`
      : ""
  }
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
