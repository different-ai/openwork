import type { ModelRef } from "@/app/types";

export type DefaultModelRuleInput = {
  /** The model this person picked themselves, or null when they never picked one. */
  ownPick: ModelRef | null;
  /**
   * Every model this person is offered right now, including models that wait
   * on their own sign-in. A model that needs sign-in is still offered.
   */
  offered: readonly ModelRef[];
  /** The free starter model, or null when policy doesn't allow it. */
  starter: ModelRef | null;
  /**
   * The first model the company provides that works now. Only used when
   * policy blocks the starter model, so nobody is left on a model they
   * aren't allowed to use.
   */
  firstCompanyModel: ModelRef | null;
};

const sameModel = (left: ModelRef, right: ModelRef) =>
  left.providerID === right.providerID && left.modelID === right.modelID;

/**
 * Which model new chats start on, worked out fresh every launch:
 * 1. the person's own pick, while they're still offered it (a model waiting
 *    on their sign-in counts: it stays picked and asks for sign-in);
 * 2. otherwise the free starter model, when policy allows it;
 * 3. when policy blocks the starter model, the first company model that works.
 * Null means none of these apply. Callers only save the person's own pick,
 * never the result of this rule.
 */
export function resolveDefaultModel(input: DefaultModelRuleInput): ModelRef | null {
  const { ownPick, offered, starter, firstCompanyModel } = input;
  if (ownPick && (offered.some((model) => sameModel(model, ownPick)) || (starter && sameModel(starter, ownPick)))) {
    return ownPick;
  }
  return starter ?? firstCompanyModel;
}
