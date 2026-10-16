/**
 * Looking at, and acting on, this machine's desktop.
 *
 * A capability of the strongest kind — the one that changes the machine rather than describing it.
 * Six tools, and they are one thing read two ways and done four ways: read a window's elements, then
 * click, type, press, or capture. The read is the primary channel and the capture is the fallback,
 * because the accessibility tree already names what a user can act on and a picture does not.
 *
 * What this plugin deliberately does not do: **it does not decide who may touch what.** Every tool
 * says the one thing it knows — that it starts `powershell.exe` — and the deployment decides, in the
 * domain's `tool_grants`, which roles may look and which may act. It does ask one thing of its own:
 * the four verbs that change the machine put a question to the user before they run, and only that
 * user's answer opens the gate — asking is not deciding, and the answer is theirs. The module
 * imports nothing from the ontology package for the same reason `test-runner` does not: a capability
 * that knew what a `Customer` was would have to know the customer's world.
 *
 * Windows-only, and stated rather than wrapped: `powershell.exe`, UIA and SendInput are the machine
 * this reaches. There is no non-Windows branch, because there is no non-Windows desktop here to
 * reach, and a tool that claimed otherwise would be lying on half its calls.
 *
 * @module @zhangcun123/computer
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { POWERSHELL, runScript } from './ps.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-computer'

/** Declared so the loader holds this plugin until the tool registry exists. */
export const inject = ['tools']

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config {
  /**
   * Window titles a verb may act on, matched as a substring. Empty means "this deployment named
   * none", and every window is addressable — which is the permissive default and is written here
   * rather than left to be discovered: name the applications you expect an agent to touch.
   */
  readonly applications?: readonly string[]

  /**
   * Whether the first act on the desktop in a session has to be approved by a user.
   *
   * The unit is the capability and not the verb: one question opens the desktop for the session it
   * was asked in, within the windows {@link Config.applications} names, and every act after it runs
   * without asking again. A question per click is a question the person answering stops reading,
   * and a confirmation nobody reads only teaches the person who gave it to click through.
   *
   * `false` switches the gate off, deliberately: asking is the safe default and is written here,
   * and a deployment that wants an agent touching the desktop unwatched has to spell that out.
   */
  readonly requireApproval?: boolean
}

/** A registered tool, in the shape the runtime's registry accepts. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  execute: (args: never, exec: ExecutionContext) => Promise<unknown>
}

/**
 * What a tool's `execute` is handed.
 *
 * Structural, like every other seam here, and read defensively: the route a session is on is the
 * only way to know whether the model can be shown a picture, and if any of this is shaped
 * differently than expected the answer is "do not attach one" rather than an exception.
 *
 * `agent` is the live agent on whose behalf the call runs, set by the host's agent loop — one per
 * session, and the identity the approval gate keys on. There is deliberately no `agentId`: the host
 * sets no such field, and a gate that keyed on one would ask again on every act while looking like
 * it remembered (which is exactly what the first version of this gate did).
 */
export interface ExecutionContext {
  agent?: {
    id?: string
    session?: { requestHeader?(): { config?: { provider?: string; model?: string } } }
    options?: { provider?: string; model?: string }
  }
  signal?: unknown
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface ComputerContext {
  tools: { register(tool: RegisteredTool): void }
  logger?: { warn(message: string): void; info?(message: string): void }
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
  get?<Service>(name: string): Service | undefined
}

/** The attachment store a profile provides, when it has one. */
export interface AttachmentsSurface {
  /** Store image bytes and get back the reference a tool result carries. */
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
  imageLimits: { maxImageBytes: number; maxImageDimension: number; maxImagePixels: number }
}

/** A stored image, as a tool result carries it. Mirrors the host's `ImageAttachmentRef`. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** Just enough of the model service to ask what the current route accepts. */
export interface LlmSurface {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: unknown,
  ): Promise<{ inputModalities?: readonly string[] }>
}

/** The declaration channel, as the governance plugin publishes it. */
export interface GovernanceSurface {
  declareTool(
    name: string,
    access: { writes?: readonly string[]; executes?: readonly string[]; commands?: readonly string[] },
  ): () => void
}

/** The skill registry a profile provides, when it has one. */
export interface SkillSurface {
  skills: {
    register(skill: {
      name: string
      description: string
      whenToUse?: string
      content: string
      source: 'runtime'
    }): () => void
  }
  effect?(callback: () => () => void, label?: string): void
}

/**
 * The vocabulary the host's approval service answers in. Copied from
 * `@deepseek-ai/dsh-user-approval`'s types rather than imported, like every other seam here: a
 * closed set of four, and `allowed-once` is the only one that grants anything.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The slice of the host's approval service this plugin uses.
 *
 * `request` answers in the vocabulary above, and the host's contract names the obligation this
 * plugin is built around: **an asker fails closed on `unavailable`.** A gate that opened when
 * nobody could be asked would open in exactly the runs nobody is watching.
 */
export interface ApprovalSurface {
  /** Ask for one decision about one tool call. `agent` is opaque here — the service routes it. */
  request(request: {
    agent: unknown
    toolName: string
    reason?: string
    signal?: unknown
  }): Promise<ApprovalOutcome>
}

/** The name both packages state rather than import. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

/** The approval service's name in the runtime's registry, stated rather than imported. */
const APPROVAL_SERVICE = 'approval'

/** Every verb this deployment offers, for the declaration loop and for the manual to agree with. */
const VERBS = [
  'list_windows',
  'get_window_state',
  'click',
  'click_at',
  'type_text',
  'press_key',
  'screenshot',
] as const

/** One of the verbs this plugin offers. */
type Verb = (typeof VERBS)[number]

/**
 * The verbs that change the machine, and the only ones the approval gate is in front of.
 *
 * Looking is not acting: the three read verbs ask nobody, which is what makes "read the window,
 * then ask" a workflow rather than a prompt. The reason the line is drawn here and not per verb is
 * that approval is granted to the capability and lasts the session — a name-by-name list of what
 * asks would describe a granularity this gate no longer has.
 */
const ACTING_VERBS: readonly Verb[] = ['click', 'click_at', 'type_text', 'press_key']
const ACTING_VERB_NAMES = new Set<string>(ACTING_VERBS)

/**
 * What an act that was refused reads like, one sentence per ending.
 *
 * The three endings are three different problems and the model's answer to each differs, so they
 * must not read the same: a refusal is a decision not to be retried unchanged, a withdrawn question
 * can be asked again, and an environment with no answerer never had anyone to ask.
 */
const REFUSAL_DETAIL: Record<Exclude<ApprovalOutcome, 'allowed-once'>, string> = {
  // Deliberately not "the user said no": the host answers `rejected` both for a person who declined
  // and for a session whose policy never prompts at all, and a message that claimed the first would
  // have the model tell a user they refused something they were never shown.
  rejected:
    'The call was refused, so nothing ran. Do not repeat it unchanged — say what you were about to ' +
    'do and ask the user how they want to proceed.',
  cancelled:
    'The question was withdrawn before it was answered, so nothing ran. Ask again if the act is ' +
    'still wanted.',
  unavailable:
    'Nobody could be asked: this environment has no answerer for an approval question. That is a ' +
    'refusal and not a permission, so the act was not performed.',
}

/** The one shape of an approval refusal, so a caller always reads why, and what follows from it. */
function notApproved(verb: string, why: string, detail: string): string {
  return `${verb}: NOT APPROVED (${why}) — nothing was done. ${detail}`
}

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  // `required` belongs to the object, not to the property — nested inside it, the host rejects the
  // whole schema and the plugin's `apply` goes down with it. Learned the hard way in `test-runner`.
  required: ['text'],
} as const

const TEXT_OUTPUT = {
  schema: TEXT_SCHEMA,
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: (value as { text: string }).text }],
} as const

/**
 * A stored image, in the shape the host's tool-result schema accepts.
 *
 * Copied from the host's own `read_image`, which is the only place the contract is written down:
 * the value is `{ attachmentId, mediaType, bytes, width, height, name? }` and the content block
 * that carries it is `{ type: 'image', attachment: <that ref> }`.
 *
 * `required` is at the object level and never inside a property. The host's raw registry rejects
 * `required: true` on a property with `unsupported JSON schema` and takes the whole `apply` down —
 * which is what happened the first time this schema was written, and why the test beside this file
 * now walks the *output* schemas as well as the parameters. The host's own `read_image` writes
 * `required: true` because it is registered through a helper that rewrites it first; a plugin
 * registered through the raw registry has no such translation.
 */
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      required: ['width', 'height'],
    },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
} as const

const SCREENSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' }, image: IMAGE_SCHEMA },
  required: ['text'],
} as const

/** What the capture tool hands the render: always the words, and the picture when one can be shown. */
export interface ScreenshotValue {
  text: string
  image?: ImageAttachmentRef
}

const SCREENSHOT_OUTPUT = {
  schema: SCREENSHOT_SCHEMA,
  render: (_args: unknown, value: unknown) => {
    const shot = value as ScreenshotValue
    const blocks: Record<string, unknown>[] = [{ type: 'text', text: shot.text }]
    // The picture is a second block, not a replacement: the text carries what the caller has to know
    // to act on it — which window it is, where that window sits, and how the pixels map to screen
    // coordinates — and a block list is how the host is told to show both.
    if (shot.image !== undefined) blocks.push({ type: 'image', attachment: shot.image })
    return blocks
  },
} as const

/** A reply from `invoke.ps1`, narrowed to what the render needs and nothing it might invent. */
export interface InvokeReply {
  ok?: boolean
  did?: string
  refused?: string
  detail?: string
  expected?: { control?: string; name?: string }
  actual?: { index?: number; control?: string; name?: string }
  window?: WindowInfo
}

export interface WindowInfo {
  handle?: number
  title?: string
  pid?: number
  class?: string
  foreground?: boolean
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface WindowList {
  screen?: { width?: number; height?: number }
  windows?: WindowInfo[]
  skipped?: string[]
}

export interface WindowState {
  window?: WindowInfo
  count?: number
  truncated?: boolean
  elements?: {
    index?: number
    depth?: number
    control?: string
    name?: string
    value?: string | null
    enabled?: boolean
    offscreen?: boolean
    x?: number
    y?: number
    width?: number
    height?: number
  }[]
}

/** One window as a line: what addresses it, what it is called, and whether it is in front. */
function windowLine(w: WindowInfo): string {
  return (
    `  handle ${String(w.handle ?? 0).padStart(10)}  ` +
    `${(w.title ?? '').length > 0 ? `"${w.title}"` : '(untitled)'}  ` +
    `[${w.class ?? ''}] pid ${w.pid ?? 0}  ${w.width ?? 0}x${w.height ?? 0} at ${w.x ?? 0},${w.y ?? 0}` +
    `${w.foreground === true ? '  (foreground)' : ''}`
  )
}

/** The window list as text, with the screen it sits on and anything that could not be described. */
export function describeWindows(list: WindowList): string {
  const lines: string[] = []
  lines.push(`screen   ${list.screen?.width ?? 0} x ${list.screen?.height ?? 0}`)
  const windows = list.windows ?? []
  lines.push(`windows  ${windows.length}`)
  for (const w of windows) lines.push(windowLine(w))
  if ((list.skipped ?? []).length > 0) {
    lines.push(`${list.skipped?.length ?? 0} window(s) could not be read: ${(list.skipped ?? []).join('; ')}`)
  }
  lines.push('', 'Address a window by its handle. Read its elements with get_window_state before acting.')
  return lines.join('\n')
}

/** One element as a line: its index, what it is, its label, and where it is. */
function elementLine(e: NonNullable<WindowState['elements']>[number]): string {
  const flags = [e.enabled === false ? 'disabled' : '', e.offscreen === true ? 'offscreen' : '']
    .filter((f) => f.length > 0)
    .join(',')
  const value = e.value === undefined || e.value === null || e.value.length === 0 ? '' : ` = "${e.value}"`
  return (
    `  [${String(e.index ?? 0).padStart(3)}] ` +
    `${(e.control ?? '').padEnd(12)} ` +
    `${(e.name ?? '').length > 0 ? `"${e.name}"` : '(no name)'}${value}` +
    `  ${e.width ?? 0}x${e.height ?? 0} at ${e.x ?? 0},${e.y ?? 0}` +
    `${flags.length > 0 ? `  (${flags})` : ''}`
  )
}

/** A window's elements as text, with the counts a caller needs to know what it is not seeing. */
export function describeWindowState(state: WindowState): string {
  const lines: string[] = []
  const w = state.window ?? {}
  lines.push(`window   handle ${w.handle ?? 0}  "${w.title ?? ''}"  [${w.class ?? ''}] pid ${w.pid ?? 0}`)
  const elements = state.elements ?? []
  lines.push(`elements ${state.count ?? elements.length}${state.truncated === true ? ' (truncated — not everything fits)' : ''}`)
  for (const e of elements) lines.push(elementLine(e))
  if (state.truncated === true) {
    lines.push('', 'The list was cut before the window was exhausted; a control you need may be past it.')
  }
  return lines.join('\n')
}

/** The answer to an act: what happened, or why it was refused and what was there instead. */
export function describeInvoke(reply: InvokeReply, verb: string): string {
  if (reply.ok === true) {
    const at = reply.actual ?? {}
    const where = at.index === undefined ? '' : ` (index ${at.index}, "${at.name ?? ''}")`
    return `ok — ${reply.did ?? verb}${where}`
  }
  const lines: string[] = []
  lines.push(`REFUSED (${reply.refused ?? 'unknown'}): ${reply.detail ?? ''}`)
  if (reply.expected !== undefined || reply.actual !== undefined) {
    lines.push(
      `  expected ${reply.expected?.control ?? '?'}/"${reply.expected?.name ?? ''}" ` +
        `but index ${reply.actual?.index ?? '?'} is ${reply.actual?.control ?? '?'}/"${reply.actual?.name ?? ''}"`,
    )
  }
  lines.push('', 'Nothing was done. Re-read the window with get_window_state and address the element again.')
  return lines.join('\n')
}

/** The manual, inlined so it cannot be left out of the tarball the way a markdown file would be. */
const MANUAL = `# Working this machine's desktop

Seven tools and **two channels**. The tree channel names things: \`list_windows\` gives you handles,
\`get_window_state\` reads one window's elements each with a stable \`index\`, and \`click\`,
\`type_text\`, \`press_key\` act on what you saw there. The picture channel shows you things:
\`screenshot\` returns an image, and \`click_at\` acts on a point in it.

**Use the tree whenever it has an answer** — it is cheaper, it names what it is, and \`click\`
re-checks before acting. Use the picture only where the tree is silent, which includes the whole
desktop: the shell's icons are published to nothing, so a picture and \`click_at\` are the only way
to reach them.

## What each verb needs, and why it asks twice

\`click\` and \`type_text\` take the \`control\` and \`name\` you saw at that \`index\`, and the tool
walks the tree again before acting. If the element there is no longer that control with that name,
the call is **refused** rather than performed. This is not ceremony: between reading and clicking, a
list can reorder, a dialog can close, and index 7 can become a different button. A refused click
costs you a re-read; a wrong click costs whatever it landed on, and clicking is not undoable by
re-reading. When you are refused with \`index-moved\`, read the window again and re-address.

## click_at is the blind verb, so it asks you to have looked

\`click_at\` names no element — only a point — so there is nothing for it to re-check by name. Two
things follow. First, the point must come from a **screenshot of that same window**; the text beside
a capture tells you exactly how a pixel in the picture maps to the screen coordinates \`click_at\`
wants, including when the picture was scaled down. Second, the point is checked against the window's
own rectangle, and one outside it is refused rather than clicked somewhere else — but nothing stops
a coordinate that is inside the window and still on the wrong control.

After a \`click_at\`, **take another screenshot** unless the result was unambiguous. It is the only
verb that cannot tell you whether it hit what you meant.

A desktop shortcut only opens on the **second** click, so pass \`double: true\` for one. A single
click there only selects the icon.

## Prefer the verb that has an undo

If a value can be set by **typing**, type it. Reaching a field by clicking a sequence of controls
depends on every intermediate state being what you assumed, and none of those clicks are reversible.
\`type_text\` writes into the element you name; \`click\` prefers the control's own accessibility
action and falls back to a real pointer at its centre, which lands wherever the window is now.

## What a capture gives you, and when it does not

\`screenshot\` returns the picture **when the deployment can show it to you** — the host has to be
able to attach it and the model has to declare image input. When either is missing the tool still
works; it returns the words and a file path, and says in that text why the picture was not attached.
Read that line rather than assuming you were shown something, because acting on a picture you did
not receive means acting on coordinates you made up.

## Who may act is not decided here

Every verb starts \`powershell.exe\`, and the deployment's \`tool_grants\` decides which roles may run
it — looking and touching are separate grants, and a refusal from the guard happens before the
script runs. A refusal from the guard and a refusal from the index check read differently, and both
are in the record. Nothing here decides which *application* is legitimate; a deployment names the
window titles it will speak to through this plugin's \`applications\` setting, and an unnamed window
is the deployment's to exclude.

## An act can also be refused because the user was asked

The four verbs that change the machine — \`click\`, \`click_at\`, \`type_text\`, \`press_key\` — stop
**before** the script runs while this session's desktop approval is closed. What is approved is the
capability, not the verb: **the first act asks once**, the question says which windows the answer
covers and what that first act would do, and an explicit yes opens the desktop for the rest of the
session — every later act runs without asking again. Asking per click would make a ten-step task ten
questions, and a confirmation nobody reads only teaches the person answering it to click through.

Anything other than that yes comes back as \`NOT APPROVED\`, naming which of the three it was: the
user declined, the question was withdrawn, or this environment has nobody to ask. In all three the
act did not happen and the gate stayed shut, so the next act asks again. The answer is not to re-read
a window — say what you were about to do and let the user decide. The three verbs that only look
never ask at all: **read first, then act**, because a read is what makes the question answerable.
`

/** The manual as the skill registry takes it. */
const MANUAL_SKILL = {
  name: 'work-the-desktop',
  description:
    "Look at this machine's windows and elements and act on them — click, type, press a key, or " +
    'capture — with the order and the refusals that keep an act from landing on the wrong thing.',
  whenToUse:
    'Use before any click or keystroke on the desktop, and whenever one was refused and you need to ' +
    'know whether it was the guard or a moved index. Not for reading files (the host reads those) ' +
    'and not for deciding what an application should contain.',
  content: MANUAL,
  source: 'runtime',
} as const

/** Where captures are written, kept outside the per-call temp directory so they outlive the call. */
function captureDir(): string {
  const dir = join(tmpdir(), 'deepwork-computer')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A file name no second call in the same millisecond will choose. */
let captureCounter = 0
function capturePath(): string {
  captureCounter += 1
  return join(captureDir(), `capture-${Date.now()}-${captureCounter}.png`)
}

/**
 * Register the capability's tools.
 *
 * @param ctx - The runtime context.
 * @param config - Which applications this deployment will speak to, if it named any.
 */
export function apply(ctx: ComputerContext, config: Config = {}): void {
  const applications = [...(config.applications ?? [])]
  const warn = (message: string): void => ctx.logger?.warn(message)
  const allowList = applications.length > 0 ? { applications } : {}

  // Whether a picture may be put in front of this session's model — asked of the host rather than
  // assumed, and every unknown answers "no". A screenshot that degrades to a file path costs the
  // caller little; an image handed to a route that does not take one would fail the whole request.
  // Returns undefined when it is allowed, and the reason as a sentence when it is not.
  const imageRefusal = async (exec: ExecutionContext): Promise<string | undefined> => {
    const llm = ctx.get?.<LlmSurface>('llm')
    if (llm === undefined) return 'no model service is mounted'
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (provider === undefined || model === undefined) return 'the session route could not be resolved'
    try {
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (info.inputModalities?.includes('image') !== true) {
        return `model "${model}" does not declare image input`
      }
      return undefined
    } catch (error) {
      return `the route could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // The gate in front of acting on the desktop — the reason this plugin asks a user instead of
  // deciding for them.
  //
  // What is approved is the capability, not the verb, and the approval lasts the session it was
  // asked in: one question, and the four acting verbs run without asking again. A question per
  // click is a question the person answering stops reading, and a confirmation nobody reads only
  // teaches the person who gave it to click through. The read verbs ask nothing at all, which is
  // what makes "read the window, then ask" a workflow rather than a prompt.
  //
  // The scope travels inside the question, because it is the only thing bounding what the answer
  // grants: `applications` names the windows, and a deployment that named none is told so in the
  // question itself rather than discovering it in what the agent then does.
  const requireApproval = config.requireApproval ?? true
  const scope = applications.length === 0 ? 'every window on this machine' : applications.join(', ')

  /**
   * The sessions whose desktop approval is already open.
   *
   * Keyed by the agent object the host hands the call, which is what a session is here: one live
   * agent per session, and a second agent in the same process was not approved and is asked on its
   * own first act. Keyed by the object and not by a field of it, because the first version of this
   * gate keyed on `agentId` — a field nothing sets — and asked again on every single act while
   * looking exactly like a gate that remembered.
   *
   * In memory only, so a restart closes the gate, and a call that arrives with no agent at all is
   * never remembered: an unidentified caller asks every time rather than opening a gate nobody can
   * attribute to anyone.
   *
   * There is deliberately no configuration that pre-opens it. That decision is `requireApproval:
   * false`, and writing it twice would put the same grant somewhere nobody looks.
   */
  const open = new Set<unknown>()

  /**
   * What the gate remembers an approval against.
   *
   * The host hands the live agent, and names it in `id` — the session id, which is what the guard on
   * the write path already resolves roles from. That string is used when it is there, and the object
   * itself when it is not, so the gate is keyed on something the host actually sets: the first
   * version keyed on `agentId`, a field nothing sets, and asked again on every act while looking
   * exactly like a gate that remembered.
   */
  const keyOf = (exec: ExecutionContext): unknown => {
    const who = exec.agent
    if (who === undefined) return undefined
    return typeof who.id === 'string' && who.id.length > 0 ? who.id : who
  }

  /**
   * Ask before acting, and hand back what the caller reads when the act must not happen.
   * `undefined` means it may go ahead.
   *
   * The service is looked up here, per call, rather than during `apply`: the profile mounts it, and
   * a plugin that resolved it at mount time would hold a service that was not there yet. Every
   * ending that is not the one-shot grant refuses — including a service that threw — and the
   * refusal is text rather than an exception, because the model has to read it and tell the user.
   */
  const refuseUnlessApproved = async (
    verb: Verb,
    exec: ExecutionContext,
    reason: string,
  ): Promise<{ text: string } | undefined> => {
    if (!requireApproval) return undefined
    // Looking is not acting, and there is nothing to ask about a read that ran none of this.
    if (!ACTING_VERB_NAMES.has(verb)) return undefined
    const who = keyOf(exec)
    if (who !== undefined && open.has(who)) return undefined
    const approval = ctx.get?.<ApprovalSurface>(APPROVAL_SERVICE)
    if (approval === undefined) {
      return {
        text: notApproved(
          verb,
          'no-approval-service',
          'This runtime has nothing mounted that can ask, and an act nobody can approve is not one ' +
            'this plugin performs.',
        ),
      }
    }
    // The question the person answers, and the only place the scope is stated. It carries the act
    // that prompted it so the answer is a decision about something rather than about a verb, and it
    // says what the answer covers, because "yes" to a click is not the same answer as "yes to this
    // session on these windows" and the person has to know which one they are giving.
    const request = {
      agent: exec.agent,
      toolName: verb,
      reason:
        `Allow this agent to operate the desktop for this session — windows: ${scope}. ` +
        `First act: ${reason}. Every later act in this session runs without asking again.`,
      signal: exec.signal,
    }
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request(request)
    } catch (error) {
      // Throwing is not the same as refusing, and it reads differently: the host throws when the
      // question has nowhere to go (no open turn, no session), which is a reason to not act rather
      // than a fault in the act.
      return {
        text: notApproved(
          verb,
          'ask-failed',
          `The question could not be asked: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }
    }
    if (outcome === 'allowed-once') {
      if (who === undefined) return undefined
      open.add(who)
      // Logged where the operator can find it, and audited by the host in the session itself: the
      // question and its answer are both appended, so "when was this opened, and for what" is
      // answered by the record rather than by this line.
      ctx.logger?.info?.(`computer: desktop operation approved for this session — windows: ${scope}`)
      return undefined
    }
    return { text: notApproved(verb, outcome, REFUSAL_DETAIL[outcome]) }
  }

  ctx.tools.register({
    name: 'list_windows',
    description:
      "List this machine's top-level windows: each one's handle, title, class, process and bounds, " +
      'plus the screen size. Address a window by its handle in every other verb.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUTPUT,
    async execute(_args: unknown, exec: ExecutionContext): Promise<unknown> {
      const refused = await refuseUnlessApproved('list_windows', exec, 'list the windows on this desktop')
      if (refused !== undefined) return refused
      const outcome = await runScript('list-windows.ps1')
      if (outcome.json === undefined) throw new Error(`list_windows: ${outcome.missing ?? 'no result'}`)
      return { text: describeWindows(outcome.json as WindowList) }
    },
  })

  ctx.tools.register({
    name: 'get_window_state',
    description:
      "Read one window as a flat, ordered list of the elements a user can act on — each with a " +
      'stable `index`, its control type, name, value and bounds. The index is how a later verb ' +
      'names an element, and it is stable only until the window changes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window handle, from list_windows.' },
        maxNodes: {
          type: 'integer',
          description: 'Most elements to return before truncating. Defaults to 400.',
        },
      },
      required: ['handle'],
    },
    output: TEXT_OUTPUT,
    async execute(args: { handle: number; maxNodes?: number }, exec: ExecutionContext): Promise<unknown> {
      const refused = await refuseUnlessApproved(
        'get_window_state',
        exec,
        `read the elements of window ${args.handle}`,
      )
      if (refused !== undefined) return refused
      const maxNodes = args.maxNodes ?? 400
      const outcome = await runScript('get-window-state.ps1', [args.handle, maxNodes])
      if (outcome.json === undefined) throw new Error(`get_window_state: ${outcome.missing ?? 'no result'}`)
      return { text: describeWindowState(outcome.json as WindowState) }
    },
  })

  ctx.tools.register({
    name: 'click',
    description:
      "Click element `index` in window `handle`. Pass the `control` and `name` you saw at that " +
      'index: the tool re-reads the window first, and refuses if that index is no longer that ' +
      'element. Prefers the control\'s accessibility action, falling back to the pointer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window handle.' },
        index: { type: 'integer', description: 'The element index, from get_window_state.' },
        control: { type: 'string', description: 'The control type you saw at that index, e.g. Button.' },
        name: { type: 'string', description: 'The element name you saw at that index (may be empty).' },
      },
      required: ['handle', 'index', 'control', 'name'],
    },
    output: TEXT_OUTPUT,
    async execute(
      args: { handle: number; index: number; control: string; name: string },
      exec: ExecutionContext,
    ): Promise<unknown> {
      const refused = await refuseUnlessApproved(
        'click',
        exec,
        `click element ${args.index} (${args.control} "${args.name}") in window ${args.handle}`,
      )
      if (refused !== undefined) return refused
      const payload = {
        expect: { control: args.control, name: args.name },
        ...allowList,
      }
      const outcome = await runScript('invoke.ps1', ['click', args.handle, args.index], payload)
      if (outcome.json === undefined) throw new Error(`click: ${outcome.missing ?? 'no result'}`)
      return { text: describeInvoke(outcome.json as InvokeReply, 'click') }
    },
  })

  ctx.tools.register({
    name: 'click_at',
    description:
      'Click at a point in a window, given SCREEN coordinates. This is the blind verb: it names no ' +
      'element, so the coordinates must come from a screenshot of that same window, and it is the ' +
      'only way to reach something the accessibility tree does not publish. The point is checked ' +
      'against the window\'s own rectangle first, and a point outside it is refused rather than ' +
      'clicked somewhere else.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window the point was measured in.' },
        x: { type: 'integer', description: 'Screen x, measured on a screenshot of that window.' },
        y: { type: 'integer', description: 'Screen y, measured on a screenshot of that window.' },
        double: {
          type: 'boolean',
          description: 'Click twice — a desktop shortcut only opens on the second click.',
        },
      },
      required: ['handle', 'x', 'y'],
    },
    output: TEXT_OUTPUT,
    async execute(
      args: { handle: number; x: number; y: number; double?: boolean },
      exec: ExecutionContext,
    ): Promise<unknown> {
      const refused = await refuseUnlessApproved(
        'click_at',
        exec,
        `click at screen point ${args.x},${args.y} in window ${args.handle}${args.double === true ? ', twice' : ''}`,
      )
      if (refused !== undefined) return refused
      const payload = {
        x: args.x,
        y: args.y,
        ...(args.double === true ? { double: true } : {}),
        ...allowList,
      }
      const outcome = await runScript('invoke.ps1', ['click_at', args.handle, -1], payload)
      if (outcome.json === undefined) throw new Error(`click_at: ${outcome.missing ?? 'no result'}`)
      return { text: describeInvoke(outcome.json as InvokeReply, 'click_at') }
    },
  })

  ctx.tools.register({
    name: 'type_text',
    description:
      "Type `text` into element `index` in window `handle`, characters in order. Pass the `control` " +
      'and `name` you saw there: the window is re-read first and the call is refused if that index ' +
      'has moved. Typing is the preferred way to set a value — it has an undo, a sequence of clicks ' +
      'does not.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window handle.' },
        index: { type: 'integer', description: 'The element index, from get_window_state.' },
        control: { type: 'string', description: 'The control type you saw at that index.' },
        name: { type: 'string', description: 'The element name you saw at that index (may be empty).' },
        text: { type: 'string', description: 'The text to type, including non-ASCII characters.' },
      },
      required: ['handle', 'index', 'control', 'name', 'text'],
    },
    output: TEXT_OUTPUT,
    async execute(
      args: {
        handle: number
        index: number
        control: string
        name: string
        text: string
      },
      exec: ExecutionContext,
    ): Promise<unknown> {
      // The typed text is counted, never quoted: it is the one argument here that may be a password,
      // and the question is shown to a person who is being asked to approve the act.
      const refused = await refuseUnlessApproved(
        'type_text',
        exec,
        `type ${args.text.length} character(s) into element ${args.index} ` +
          `(${args.control} "${args.name}") in window ${args.handle}`,
      )
      if (refused !== undefined) return refused
      const payload = {
        expect: { control: args.control, name: args.name },
        text: args.text,
        ...allowList,
      }
      const outcome = await runScript('invoke.ps1', ['type_text', args.handle, args.index], payload)
      if (outcome.json === undefined) throw new Error(`type_text: ${outcome.missing ?? 'no result'}`)
      return { text: describeInvoke(outcome.json as InvokeReply, 'type_text') }
    },
  })

  ctx.tools.register({
    name: 'press_key',
    description:
      'Send one key to window `handle`, optionally with modifiers — `enter`, `tab`, `esc`, ' +
      '`ctrl+s`, `alt+F4`. The window is brought forward first; the key goes to whatever holds focus.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window handle.' },
        key: {
          type: 'string',
          description: 'A key, or modifiers joined to one with "+", e.g. "enter" or "ctrl+s".',
        },
      },
      required: ['handle', 'key'],
    },
    output: TEXT_OUTPUT,
    async execute(args: { handle: number; key: string }, exec: ExecutionContext): Promise<unknown> {
      const refused = await refuseUnlessApproved(
        'press_key',
        exec,
        `press "${args.key}" in window ${args.handle}`,
      )
      if (refused !== undefined) return refused
      const payload = { key: args.key, ...allowList }
      const outcome = await runScript('invoke.ps1', ['press_key', args.handle, -1], payload)
      if (outcome.json === undefined) throw new Error(`press_key: ${outcome.missing ?? 'no result'}`)
      return { text: describeInvoke(outcome.json as InvokeReply, 'press_key') }
    },
  })

  ctx.tools.register({
    name: 'screenshot',
    description:
      'Capture window `handle` — or a single element of it — and return the picture itself, plus ' +
      'the words needed to act on it. This is the channel for anything the accessibility tree does ' +
      'not publish, which includes the desktop. Prefer get_window_state where it has an answer: a ' +
      'tree costs a model far less than a picture and cannot misread a label it can see.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'integer', description: 'The window handle.' },
        index: {
          type: 'integer',
          description: 'Capture only this element instead of the whole window. Omit for the window.',
        },
      },
      required: ['handle'],
    },
    output: SCREENSHOT_OUTPUT,
    async execute(args: { handle: number; index?: number }, exec: ExecutionContext): Promise<unknown> {
      const refused = await refuseUnlessApproved(
        'screenshot',
        exec,
        `capture window ${args.handle}${args.index === undefined ? '' : `, element ${args.index}`}`,
      )
      if (refused !== undefined) return refused
      const imagePath = capturePath()
      const payload = { imagePath, ...allowList }
      const outcome = await runScript('invoke.ps1', ['screenshot', args.handle, args.index ?? -1], payload)
      if (outcome.json === undefined) throw new Error(`screenshot: ${outcome.missing ?? 'no result'}`)
      const reply = outcome.json as InvokeReply
      if (reply.ok !== true) return { text: describeInvoke(reply, 'screenshot') }

      const window = reply.window ?? {}
      const shotWidth = window.width ?? 0
      const shotHeight = window.height ?? 0
      const lines = [reply.did ?? 'captured']
      lines.push(
        `window   ${window.handle ?? 0} "${window.title ?? ''}" sits at ${window.x ?? 0},${window.y ?? 0}, ` +
          `${shotWidth} x ${shotHeight}`,
      )

      // The picture, when it can be shown. The bytes come back off the file the script wrote, for
      // the same reason the read path writes files: nothing crosses as stdout.
      const attachments = ctx.get?.<AttachmentsSurface>('attachments')
      if (attachments === undefined) {
        lines.push(`the picture is a file at ${imagePath} — no image store is mounted to attach it`)
        return { text: lines.join('\n') }
      }
      const why = await imageRefusal(exec)
      if (why !== undefined) {
        lines.push(`the picture is a file at ${imagePath} — it was not attached: ${why}`)
        return { text: lines.join('\n') }
      }

      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({
          data: readFileSync(imagePath),
          mediaType: 'image/png',
          name: `window-${window.handle ?? 0}.png`,
        })
      } catch (error) {
        lines.push(
          `the picture is a file at ${imagePath} — it could not be stored: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
        return { text: lines.join('\n') }
      }

      // The mapping that makes the picture actionable. The store may hand back a smaller picture
      // than the window, and a scale factor left unstated is exactly how a click lands somewhere
      // nobody pointed at.
      const scale = ref.width > 0 && shotWidth > 0 ? shotWidth / ref.width : 1
      lines.push(
        `picture  ${ref.width} x ${ref.height} pixels as stored` +
          (scale === 1 ? '' : `, already scaled ${scale.toFixed(4)}x from ${shotWidth} x ${shotHeight}`),
      )
      lines.push(
        'Measure in the picture\'s own pixels. What reaches you may be scaled down again on the way ' +
          `— that step is chosen when the request is built and this reply cannot see it — so if the ` +
          `picture in front of you is not ${ref.width} wide, multiply your measurements by ` +
          `${ref.width} divided by the width you actually see. Check the ratio against something of ` +
          'known size in the picture (a title bar, the taskbar) before you trust a coordinate.',
      )
      lines.push(
        'click_at takes SCREEN coordinates: screen x = ' +
          `${window.x ?? 0} + round(px * ${scale.toFixed(4)}), screen y = ${window.y ?? 0} + ` +
          `round(py * ${scale.toFixed(4)}), where (px,py) is a pixel counted from this picture's top-left.`,
      )
      return { text: lines.join('\n'), image: ref }
    },
  })

  // What these tools run, told to the plugin that judges them. Every verb starts PowerShell — a
  // read reaches the machine's desktop as surely as a click changes it — so every verb declares the
  // same program, and the deployment decides by role and by the per-verb narrowing in `tool_grants`
  // which of them a caller may use. A verb that declares nothing would be a verb nothing judges.
  const governance = ctx.inject
  if (governance === undefined) {
    warn(
      'the runtime exposes no service lookup, so the computer tools cannot declare what they run ' +
        'and are not governed by the write guard',
    )
  } else {
    // The callback receives a context carrying the service, not the service itself — the same shape
    // the host's own plugins use. Reading it as the value compiled and then called a method on a
    // context that has none.
    governance([GOVERNANCE_SERVICE], (scoped: Record<string, GovernanceSurface>) => {
      for (const verb of VERBS) {
        scoped[GOVERNANCE_SERVICE]?.declareTool(verb, { executes: [POWERSHELL] })
      }
    })
  }

  const skills = ctx.inject
  if (skills === undefined) {
    warn(
      'the runtime exposes no service lookup, so this capability cannot offer its manual as a ' +
        'skill; the tools work and the guidance is missing',
    )
  } else {
    skills(['skills'], (scoped: SkillSurface) => {
      scoped.effect?.(() => scoped.skills.register(MANUAL_SKILL), 'computer: manual')
    })
  }
}
