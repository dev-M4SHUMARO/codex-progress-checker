import streamDeck from "@elgato/streamdeck";

import { CodexStatusAction } from "./actions/codex-progress-checker";
import { registerCodexIntegration } from "./codex-integration";

// アクション登録前にProperty Inspectorのセットアップ要求を受け取れるよう購読する。
registerCodexIntegration();

// Stream DeckキーへCodex状態を描画する単一アクションをSDKへ登録する。
streamDeck.actions.registerAction(
  new CodexStatusAction(),
);

// すべてのイベント購読を終えてからStream Deck本体との接続を開始する。
streamDeck.connect();
