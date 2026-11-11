/**
 * Computer-use approvals a task started from another computer waits on, as the
 * same plain-text permission a remote surface already shows and answers.
 *
 * The chat's own card on this computer keeps working; whichever answers first
 * wins. A remote answer is "once" or "reject": it never becomes a standing
 * approval ("always", a remembered folder). What the person approves is shown
 * whole (the script, the file names, the site): a request too long to show is
 * reported, but can only be approved on this computer.
 */

const TITLE_MAX = 240
const DETAIL_MAX = 2000
const EXACT_MAX = 2000
const SCRIPT_APPS = { applescript: "AppleScript", jxa: "JavaScript for Automation", blender: "Blender" }
/** The same characters the chat's card reveals: they change how text reads without changing what runs. */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F-\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

/** Text with every hidden character written as its code point, and how many there were. */
export function revealHidden(value) {
  let hidden = 0
  const text = String(value ?? "").replace(HIDDEN_CHARACTERS, (character) => {
    hidden += 1
    return `<U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`
  })
  return { text, hidden }
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * One computer-use request in words the person decides on.
 * `allow` is false when it can only be settled on this computer.
 * @param {import("@openwork/computer-use/computer-control").ComputerRequest} request
 * @returns {{ pending: { kind: "permission", requestId: string, title: string, detail: string, command?: string }, allow: boolean }}
 */
export function computerRequestPending(request) {
  let hidden = 0
  const shown = (value) => {
    const revealed = revealHidden(value)
    hidden += revealed.hidden
    return revealed.text.trim()
  }
  let title = "Set up computer use"
  let detail = "Turn on the computer use permissions on that computer. The task continues once they are on."
  let exact = ""
  let allow = false
  if (request.reason === "script" && request.script) {
    title = `Run ${SCRIPT_APPS[request.script.app] ? `a ${SCRIPT_APPS[request.script.app]}` : "an app"} script`
    detail = "It runs on that computer as you and can change your files and apps."
    exact = shown(request.script.code)
    allow = true
  } else if (request.reason === "files" && request.files) {
    const app = shown(request.files.app)
    const names = Array.isArray(request.files.names) ? request.files.names.map(shown) : []
    exact = names.join("\n")
    allow = true
    if (request.files.save === true && names.length === 1) {
      title = `Save a file from ${app}`
      detail = `The agent chose where ${app} saves on that computer.`
    } else if (names.length) {
      title = `Give ${names.length === 1 ? "a file" : `${names.length} files`} to ${app}`
      detail = `The agent chose ${names.length === 1 ? "it" : "them"} on that computer. ${app} can upload what it receives.`
    } else {
      title = `Let the agent look through files for ${app}`
      detail = `${app} opened a file panel on that computer. The agent sees the file names it shows, and asks again before handing any file over.`
    }
  } else if (request.reason === "credential" && request.credential) {
    const { site, app, appId } = request.credential
    allow = true
    if (site) {
      title = "Enter your password or code on a website"
      detail = "The agent types what you gave it into this site's sign-in field. Check the address is the site you meant."
      exact = shown(site)
    } else {
      title = "Enter your password or code in an app"
      detail = "The agent types what you gave it into this app on that computer."
      // An app's name can be copied by another app; its id is shown beside it.
      exact = app && appId && app !== appId ? `${shown(app)} (${shown(appId)})` : shown(appId ?? app ?? "")
      if (!exact) allow = false
    }
  } else if (request.placement === "remote" && typeof request.detail === "string" && request.detail.trim()) {
    detail = shown(request.detail)
  }
  if (hidden) detail += ` It has ${hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as <U+…>. Don't approve it unless you expected that.`
  if (title.length > TITLE_MAX || detail.length > DETAIL_MAX || exact.length > EXACT_MAX) {
    // Never approve what could not be shown whole.
    return { pending: { kind: "permission", requestId: String(request.id).slice(0, 240), title: "Computer use needs your approval",
      detail: "This request is too long to show here. Review it on that computer." }, allow: false }
  }
  return { pending: { kind: "permission", requestId: String(request.id).slice(0, 240), title, detail, ...(exact ? { command: exact } : {}) }, allow }
}

/**
 * What the session runner needs from computer use: the request a session waits
 * on, and the person's answer to exactly that request.
 * @param {{ pendingRequest: (input: { sessionId: string }) => import("@openwork/computer-use/computer-control").ComputerRequest | null,
 *   answerRequest: (input: { sessionId: string, answer: "allow" | "dismiss", id: string }) => Promise<unknown> }} control
 */
export function createComputerRequestAnswers(control) {
  const current = (sessionId) => {
    const request = control.pendingRequest({ sessionId })
    return request ? { request, ...computerRequestPending(request) } : null
  }
  return {
    /** @param {string} sessionId */
    pending(sessionId) {
      return current(sessionId)?.pending ?? null
    },
    /**
     * @param {string} sessionId
     * @param {{ requestId: string, decision: "once" | "reject" }} input
     */
    async answer(sessionId, input) {
      const live = current(sessionId)
      if (!live || live.pending.requestId !== input.requestId) {
        throw refusal("stale_request", "That permission is no longer pending. Read the task again.")
      }
      if (input.decision === "once" && !live.allow) {
        throw refusal("invalid_answer", live.request.reason === "setup"
          ? "Computer use can only be set up on that computer. The task continues once it is."
          : "This request can only be approved on that computer.")
      }
      try {
        await control.answerRequest({ sessionId, answer: input.decision === "once" ? "allow" : "dismiss", id: live.request.id })
      } catch (error) {
        // The request changed between the read and the answer: nothing was approved.
        throw refusal("stale_request", error instanceof Error ? error.message : "That permission is no longer pending.")
      }
    },
  }
}
