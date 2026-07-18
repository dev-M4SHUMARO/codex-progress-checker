import streamDeck from "@elgato/streamdeck";

import { CodexStatusAction } from "./actions/codex-progress-checker";

streamDeck.actions.registerAction(
  new CodexStatusAction(),
);
streamDeck.connect();
