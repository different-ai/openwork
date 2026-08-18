import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type { EngineEvent } from "./index";

type AssertAssignable<From extends To, To> = true;

type EngineSession = import("./index").Session;
type EngineMessage = import("./index").Message;
type EnginePart = import("./index").Part;

type SessionMatchesOpenCode = AssertAssignable<EngineSession, Session>;
type OpenCodeMatchesSession = AssertAssignable<Session, EngineSession>;

type MessageMatchesOpenCode = AssertAssignable<EngineMessage, Message>;
type OpenCodeMatchesMessage = AssertAssignable<Message, EngineMessage>;

type PartMatchesOpenCode = AssertAssignable<EnginePart, Part>;
type OpenCodeMatchesPart = AssertAssignable<Part, EnginePart>;

type ConsumedOpenCodeEvent = Extract<Event, { type: EngineEvent["type"] }>;
type EventMatchesOpenCode = AssertAssignable<EngineEvent, ConsumedOpenCodeEvent>;
type OpenCodeMatchesEvent = AssertAssignable<ConsumedOpenCodeEvent, EngineEvent>;

export type CompatChecks =
  | SessionMatchesOpenCode
  | OpenCodeMatchesSession
  | MessageMatchesOpenCode
  | OpenCodeMatchesMessage
  | PartMatchesOpenCode
  | OpenCodeMatchesPart
  | EventMatchesOpenCode
  | OpenCodeMatchesEvent;
