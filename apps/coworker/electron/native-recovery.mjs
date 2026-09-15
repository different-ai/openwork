import { cancelNativeV2TurnContext, nativeV2AttachmentsMatch, nativeV2InputSkillsMatch, nativeV2SkillsSchema } from "@openwork/headless-threads/v2";

export async function drainNativeTurnContext(client, threadId, turn, signal) {
  if (turn.nativeAdmission !== "attempted" || !client.nativeSkills) return false;
  return cancelNativeV2TurnContext(client.nativeSkills, threadId, { ...turn, signal });
}

/** Compare the frozen admitted input and host binding, never today's skill body. */
export async function verifyNativeTurnSkills(client, snapshot, turn, signal) {
  if (turn.skills === undefined && turn.skillSelections === undefined) return;
  const skills = nativeV2SkillsSchema.parse(turn.skills ?? []);
  if (turn.skillSelections && JSON.stringify(turn.skillSelections.map(({ id }) => id)) !== JSON.stringify(skills.map(({ id }) => id))) throw new Error("The recorded skill selections conflict with this native turn. Earlier work will not be replayed.");
  if (!nativeTurnReceipt(snapshot, turn.messageId).present) return;
  if (snapshot.native?.inputSkills !== undefined) {
    if (!nativeV2InputSkillsMatch(snapshot, turn.messageId, skills)) throw new Error("The native input attachments or host binding do not match the recorded skill selection. Earlier work will not be replayed.");
    return;
  }
  if (!client.nativeSkills) throw new Error("The frozen native skill attachments are unavailable. Earlier work will not be replayed.");
  const [history, inbox] = await Promise.all([client.nativeSkills.readHistory(snapshot.threadId, signal), client.nativeSkills.readInbox(snapshot.threadId, signal)]);
  const inputs = [...history.filter((item) => item.id === turn.messageId), ...inbox.filter((item) => item.id === turn.messageId).map((item) => ({ ...item.payload, type: item.type }))];
  if (!inputs.length || inputs.some((input) => {
    const binding = input.metadata?.headlessTurn;
    return input.type !== "user" || !binding || binding.version !== 1 || binding.messageId !== turn.messageId
      || JSON.stringify(binding.skillIds ?? []) !== JSON.stringify(skills.map(({ id }) => id))
      || !nativeV2AttachmentsMatch(input, skills)
      || (turn.prompt !== undefined && input.text !== turn.prompt)
      || (turn.agent !== undefined && binding.agent !== turn.agent)
      || (turn.model && (binding.model?.providerID !== turn.model.providerId || binding.model?.id !== turn.model.modelId || (binding.model?.variant ?? "default") !== (turn.model.variant ?? "default")));
  })) throw new Error("The native input attachments or host binding do not match the recorded skill selection. Earlier work will not be replayed.");
}

/** Native history is presentation, not an execution receipt. Keep this gate
 * separate from shared legacy clients so neither recovery nor live completion
 * can infer success from an idle session and a completed assistant message. */
export function nativeTurnReceipt(snapshot, messageId) {
  const native = snapshot.native;
  if (native?.engine !== "v2") throw new Error("The native execution receipt is unavailable. Earlier work will not be replayed.");
  const present = snapshot.messages.some((message) => message.id === messageId && message.role === "user")
    || Boolean(native.pendingInputIds?.includes(messageId));
  const outcome = native.turnOutcomes?.[messageId];
  const reply = snapshot.messages.filter((message) => message.role === "assistant" && message.parentId === messageId).at(-1);
  const failed = (message) => ({ outcome: "failed", snapshot, terminalError: { message } });
  let result = null;
  if (native.ambiguousTurns?.includes(messageId)) result = failed("The native turn boundary is ambiguous. Review its earlier work before continuing.");
  else if (outcome === "failed" || outcome === "interrupted") result = failed(native.turnErrors?.[messageId] || `The admitted step ${outcome === "interrupted" ? "was interrupted" : "failed"}. Its earlier work was kept; review it before continuing.`);
  else if (outcome === "succeeded") {
    result = !reply || reply.completedAt == null || reply.error
      ? failed(reply?.error?.message || "The reply stopped before it finished.")
      : { outcome: "settled", snapshot, terminalError: null };
  }
  return { present, result };
}

/** Only an explicitly prepared, never-attempted input may be sent. The durable
 * marker precedes every native write (including paired memory context). Older
 * records without a phase are uncertain, not permission to submit again. */
export async function dispatchNativeTurn({ client, threadId, turn, markAttempted, signal }) {
  const snapshot = await client.getThreadSnapshot(threadId, { signal });
  if (snapshot.threadId !== threadId) throw new Error("The native thread identity could not be confirmed.");
  if (nativeTurnReceipt(snapshot, turn.messageId).present) {
    await verifyNativeTurnSkills(client, snapshot, turn, signal);
    if (turn.nativeAdmission !== "attempted") await markAttempted();
    return { threadId, messageId: turn.messageId, messageCountBefore: 0, alreadyPresent: true, acceptedAt: Date.now() };
  }
  if (turn.nativeAdmission !== "prepared") throw new Error("The admitted native message is no longer available. Its work will not be replayed; review the earlier execution before continuing.");
  if (!turn.agent) throw new Error("This execution has no native agent pin. Its work will not be replayed.");
  if (turn.skills?.length || turn.skillSelections?.length) {
    if (!client.validateSkills) throw new Error("Selected skills cannot be validated for this workspace. Nothing was submitted.");
    await client.validateSkills(turn, signal);
  }
  if (client.prepareSkillOrigin) await client.prepareSkillOrigin(turn, signal);
  signal?.throwIfAborted();
  await markAttempted();
  signal?.throwIfAborted();
  const { messageId, prompt, agent, model, context, skills } = turn;
  return client.sendTurn(threadId, { messageId, prompt, agent, ...(skills !== undefined ? { skills } : {}), ...(model ? { model } : {}), ...(context ? { context } : {}), signal });
}

/** Observe the exact accepted input, even while it exists only in the inbox.
 * The headless wait owns the deadline; its result must still carry our receipt. */
export async function waitForNativeTurn(client, threadId, input) {
  const snapshot = await client.getThreadSnapshot(threadId, { signal: input.signal });
  await verifyNativeTurnSkills(client, snapshot, { ...input, messageId: input.since.messageId }, input.signal);
  const recovered = nativeTurnReceipt(snapshot, input.since.messageId).result;
  if (recovered) return recovered;
  const result = await client.waitForThread(threadId, input);
  await verifyNativeTurnSkills(client, result.snapshot, { ...input, messageId: input.since.messageId }, input.signal);
  const receipt = nativeTurnReceipt(result.snapshot, input.since.messageId).result;
  if (receipt) return receipt;
  if (result.outcome === "settled") return { ...result, outcome: "failed", terminalError: { message: "The native execution has no correlated success receipt. Review its earlier work before continuing." } };
  return result;
}
