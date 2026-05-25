type ServerState = {
  list: string[];
  active: string;
  healthy: boolean | undefined;
};

type ServerAction =
  | { type: "ready"; list: string[]; active: string }
  | { type: "active"; active: string }
  | { type: "add"; url: string }
  | { type: "remove"; url: string }
  | { type: "healthy"; healthy: boolean | undefined };

export const initialServerState: ServerState = {
  list: [],
  active: "",
  healthy: undefined,
};

export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  switch (action.type) {
    case "ready":
      return { ...state, list: action.list, active: action.active };
    case "active":
      return { ...state, active: action.active };
    case "add":
      return {
        ...state,
        list: state.list.includes(action.url) ? state.list : [...state.list, action.url],
        active: action.url,
      };
    case "remove": {
      const list = state.list.filter((item) => item !== action.url);
      return {
        ...state,
        list,
        active: state.active === action.url ? list[0] ?? "" : state.active,
      };
    }
    case "healthy":
      return { ...state, healthy: action.healthy };
  }
}
