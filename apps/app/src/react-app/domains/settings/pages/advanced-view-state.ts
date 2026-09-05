type AdvancedLocalState = {
  reconnectStatus: string | null;
  reconnectError: string | null;
  restartBusy: boolean;
  restartStatus: string | null;
  restartError: string | null;
  deepLinkOpen: boolean;
  deepLinkInput: string;
  deepLinkBusy: boolean;
  deepLinkStatus: string | null;
};

type AdvancedLocalAction =
  | { type: "reconnectStart" }
  | { type: "reconnectStatus"; status: string | null }
  | { type: "reconnectError"; error: string | null }
  | { type: "restartStart" }
  | { type: "restartStatus"; status: string | null }
  | { type: "restartError"; error: string | null }
  | { type: "restartDone" }
  | { type: "toggleDeepLink" }
  | { type: "deepLinkInput"; input: string }
  | { type: "deepLinkStart" }
  | { type: "deepLinkStatus"; status: string | null }
  | { type: "deepLinkDone" }
  | { type: "deepLinkSuccess"; status: string | null };

export const initialAdvancedLocalState: AdvancedLocalState = {
  reconnectStatus: null,
  reconnectError: null,
  restartBusy: false,
  restartStatus: null,
  restartError: null,
  deepLinkOpen: false,
  deepLinkInput: "",
  deepLinkBusy: false,
  deepLinkStatus: null,
};

export function advancedLocalReducer(
  state: AdvancedLocalState,
  action: AdvancedLocalAction,
): AdvancedLocalState {
  switch (action.type) {
    case "reconnectStart":
      return { ...state, reconnectStatus: null, reconnectError: null };
    case "reconnectStatus":
      return { ...state, reconnectStatus: action.status };
    case "reconnectError":
      return { ...state, reconnectError: action.error };
    case "restartStart":
      return { ...state, restartStatus: null, restartError: null, restartBusy: true };
    case "restartStatus":
      return { ...state, restartStatus: action.status };
    case "restartError":
      return { ...state, restartError: action.error };
    case "restartDone":
      return { ...state, restartBusy: false };
    case "toggleDeepLink":
      return { ...state, deepLinkOpen: !state.deepLinkOpen, deepLinkStatus: null };
    case "deepLinkInput":
      return { ...state, deepLinkInput: action.input };
    case "deepLinkStart":
      return { ...state, deepLinkBusy: true, deepLinkStatus: null };
    case "deepLinkStatus":
      return { ...state, deepLinkStatus: action.status };
    case "deepLinkDone":
      return { ...state, deepLinkBusy: false };
    case "deepLinkSuccess":
      return { ...state, deepLinkInput: "", deepLinkStatus: action.status };
  }
}
