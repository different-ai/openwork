type SessionScrollMode = "follow-latest" | "manual-browse";

type SessionScrollState = {
  mode: SessionScrollMode;
  topClippedMessageId: string | null;
};

type SessionScrollAction =
  | { type: "mode"; mode: SessionScrollMode }
  | { type: "topClippedMessage"; id: string | null }
  | { type: "followLatest" };

export const initialSessionScrollState: SessionScrollState = {
  mode: "follow-latest",
  topClippedMessageId: null,
};

export function sessionScrollReducer(
  state: SessionScrollState,
  action: SessionScrollAction,
): SessionScrollState {
  switch (action.type) {
    case "mode":
      return { ...state, mode: action.mode };
    case "topClippedMessage":
      return { ...state, topClippedMessageId: action.id };
    case "followLatest":
      return { mode: "follow-latest", topClippedMessageId: null };
  }
}
