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

function sameServerList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  switch (action.type) {
    case "ready": {
      if (state.active === action.active && sameServerList(state.list, action.list)) return state;
      return { ...state, list: action.list, active: action.active };
    }
    case "active":
      if (state.active === action.active) return state;
      return { ...state, active: action.active };
    case "add": {
      if (state.active === action.url && state.list.includes(action.url)) return state;
      return {
        ...state,
        list: state.list.includes(action.url) ? state.list : [...state.list, action.url],
        active: action.url,
      };
    }
    case "remove": {
      if (!state.list.includes(action.url)) return state;
      const list = state.list.filter((item) => item !== action.url);
      return {
        ...state,
        list,
        active: state.active === action.url ? list[0] ?? "" : state.active,
      };
    }
    case "healthy":
      if (Object.is(state.healthy, action.healthy)) return state;
      return { ...state, healthy: action.healthy };
  }
}
