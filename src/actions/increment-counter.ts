import {
  action,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

type CodexState =
  | "idle"
  | "working"
  | "waiting"
  | "completed"
  | "error";

type CodexStatus = {
  state: CodexState;
};

const stateColors: Record<CodexState, string> = {
  idle: "#eeeeee",
  working: "#2088ff",
  waiting: "#ffbf00",
  completed: "#22aa66",
  error: "#dd3344",
};

@action({ UUID: "com.kiyoto.codex-progress-checker.status" })
export class CodexStatusAction extends SingletonAction {
  override async onWillAppear(
    ev: WillAppearEvent,
  ): Promise<void> {
    // 仮データ。後でJSONファイルから読み込む
    const status: CodexStatus = {
      state: "working",
    };

    const svg = `
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="144"
        height="144"
        viewBox="0 0 144 144"
      >
        <rect
          width="144"
          height="144"
          rx="18"
          fill="${stateColors[status.state]}"
        />
        <text
          x="72"
          y="78"
          text-anchor="middle"
          font-size="18"
          fill="white"
        >
          ${status.state}
        </text>
      </svg>
    `;

    await ev.action.setImage(
      `data:image/svg+xml,${encodeURIComponent(svg)}`,
    );
  }
}