import streamDeck from "@elgato/streamdeck";

import { CodexStatusAction } from "./actions/increment-counter";

streamDeck.actions.registerAction(
  new CodexStatusAction(),
);

streamDeck.connect();