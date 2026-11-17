/**
 * A message sent while the agent works sits in the engine's inbox until the
 * current step ends. The engine adapter reports that wait and its end with
 * these translated event types, and session sync records them, so the two
 * agree on one meaning without importing each other.
 */
export const FOLLOW_UP_WAITING_EVENT = "session.follow_up.waiting";
export const FOLLOW_UP_SETTLED_EVENT = "session.follow_up.settled";
