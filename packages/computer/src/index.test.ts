/**
 * Integration tests for the capability's own `apply`, and for the text it hands the model.
 *
 * These exist for the same reason `test-runner`'s do: the work of the tools is in PowerShell, which
 * no unit test here can reach, so what is left to pin is the mounting — that the verbs reach the
 * registry, that each one declares what it runs, and that the manual is offered. The one thing that
 * *can* be checked here about the output is its shape, and that is where the last capability's worst
 * failure lived: a `required` nested inside a property made the host reject the whole schema, and
 * `apply` went down with it while every other test stayed green.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apply,
  describeInvoke,
  describeWindows,
  describeWindowState,
  type ApprovalOutcome,
  type ApprovalSurface,
  type ComputerContext,
  type ExecutionContext,
} from './index.ts'

interface Harness {
  ctx: ComputerContext
  tools: {
    name: string
    description: string
    parameters: { required?: unknown; properties?: Record<string, unknown> }
    output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
    execute: (args: never, exec: ExecutionContext) => Promise<unknown>
  }[]
  declared: { tool: string; access: { executes?: readonly string[] } }[]
  skills: { name: string; description: string; whenToUse?: string; content: string }[]
  logs: string[]
}

function harness(
  options: {
    governance?: boolean
    skills?: boolean
    inject?: boolean
    /** The approval service the profile would mount. `null` is a context with no lookup at all. */
    approval?: ApprovalSurface | null | undefined
  } = {},
): Harness {
  const state: Harness = {
    tools: [],
    declared: [],
    skills: [],
    logs: [],
    ctx: undefined as unknown as ComputerContext,
  }
  const wantsGovernance = options.governance ?? true
  const wantsSkills = options.skills ?? true

  state.ctx = {
    tools: {
      register(tool): void {
        state.tools.push(tool as Harness['tools'][number])
      },
    },
    logger: { warn: (message) => state.logs.push(message), info: (message) => state.logs.push(message) },
    ...(options.approval === null
      ? {}
      : {
          get: ((name: string) =>
            name === 'approval' ? options.approval : undefined) as ComputerContext['get'],
        }),
    ...(options.inject === false
      ? {}
      : {
          inject: ((names: readonly string[], callback: (scoped: never) => void) => {
            const scoped: Record<string, unknown> = {}
            if (names.includes('deepworkGovernance')) {
              if (!wantsGovernance) return
              scoped.deepworkGovernance = {
                declareTool: (tool: string, access: Harness['declared'][number]['access']) => {
                  state.declared.push({ tool, access })
                  return () => {}
                },
              }
            }
            if (names.includes('skills')) {
              if (!wantsSkills) return
              scoped.skills = {
                register: (skill: Harness['skills'][number]) => {
                  state.skills.push(skill)
                  return () => {}
                },
              }
              // The lifetime hook belongs to the context, not to the registry.
              scoped.effect = (callback: () => () => void) => callback()
            }
            callback(scoped as never)
          }) as ComputerContext['inject'],
        }),
  }
  return state
}

const VERBS = ['click', 'click_at', 'get_window_state', 'list_windows', 'press_key', 'screenshot', 'type_text']

test('a deployment gets seven verbs, a declaration for each, and the manual', () => {
  const h = harness()
  apply(h.ctx)

  assert.deepEqual(h.tools.map((t) => t.name).sort(), VERBS)
  assert.deepEqual(h.skills.map((s) => s.name), ['work-the-desktop'])
})

test('every verb declares the program it runs, so none is a verb nothing judges', () => {
  // The whole point of the governance channel: the guard has never heard of these tools, and a verb
  // that declares nothing walks past the boundary that would refuse the same reach made by hand.
  const h = harness()
  apply(h.ctx)

  assert.deepEqual(h.declared.map((d) => d.tool).sort(), VERBS)
  for (const d of h.declared) {
    assert.deepEqual(d.access, { executes: ['powershell.exe'] }, `${d.tool} must declare its program`)
  }
})

test('no schema nests `required` inside a property — the host rejects that and takes `apply` down', () => {
  const h = harness()
  apply(h.ctx)

  for (const tool of h.tools) {
    // Both halves, walked recursively. The first version of this test looked at `parameters` only,
    // and the output schema then shipped with `required: true` on every property: the raw registry
    // answered `unsupported JSON schema`, `apply` went down, and the plugin did not load at all.
    // A real profile caught it; this test did not. It does now.
    for (const schema of [...objectSchemas(tool.parameters), ...objectSchemas(tool.output.schema)]) {
      for (const [key, prop] of Object.entries((schema['properties'] ?? {}) as Record<string, unknown>)) {
        const property = prop as Record<string, unknown>
        const isObjectSchema = property['type'] === 'object' && property['properties'] !== undefined
        // The host's words: `required is not supported on type "string"`. A property that is itself
        // an object schema carries its own object-level `required`, which is the legal form; a
        // scalar property that carries one is the shape that took `apply` down.
        if (property['required'] !== undefined && !isObjectSchema) {
          assert.fail(`${tool.name}: property "${key}" carries a required but is not an object`)
        }
      }
      // `list_windows` takes no argument, so it has no `required` at all.
      const required = schema['required']
      if (required !== undefined) {
        assert.ok(Array.isArray(required), `${tool.name}: required belongs to the object, as an array`)
      }
    }
  }
})

/** Every object schema anywhere in a document, so a check cannot miss one by looking shallowly. */
function objectSchemas(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') return found
  const record = node as Record<string, unknown>
  const properties = record['properties']
  if (properties !== undefined && typeof properties === 'object' && properties !== null) {
    found.push(record)
    for (const property of Object.values(properties as Record<string, unknown>)) {
      objectSchemas(property, found)
    }
  }
  return found
}

test('a verb that names an element makes the caller say what it saw there', () => {
  // The check that keeps a click off the wrong button is only as good as the expectation it is
  // given, so `control` and `name` are required arguments of the two element-addressed verbs.
  const h = harness()
  apply(h.ctx)

  for (const name of ['click', 'type_text']) {
    const tool = h.tools.find((t) => t.name === name)
    const required = (tool?.parameters.required ?? []) as string[]
    assert.ok(required.includes('control'), `${name} must require control`)
    assert.ok(required.includes('name'), `${name} must require name`)
    assert.ok(required.includes('index'), `${name} must require index`)
  }
})

test('the manual is a skill the registry would accept', () => {
  const h = harness()
  apply(h.ctx)
  const [manual] = h.skills

  assert.match(manual?.name ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok((manual?.description.length ?? 0) > 0)
  assert.ok((manual?.whenToUse?.length ?? 0) > 0)
  assert.ok((manual?.content.length ?? 0) > 0)
  // It says how and when, not what — the tool descriptions already answer what. The three things a
  // model gets wrong without being told: that there are two channels and when to use which, that
  // `click_at` cannot verify itself, and that a capture may not have been attached at all.
  assert.match(manual?.content ?? '', /two channels/)
  assert.match(manual?.content ?? '', /blind verb/)
  assert.match(manual?.content ?? '', /index-moved/)
  assert.match(manual?.content ?? '', /take another screenshot/)
  assert.match(manual?.content ?? '', /was not attached/)
})

test('click_at takes a point, and its description says it cannot check what it will hit', () => {
  const h = harness()
  apply(h.ctx)
  const tool = h.tools.find((t) => t.name === 'click_at')
  const required = ((tool?.parameters.required ?? []) as string[]).slice().sort()

  assert.deepEqual(required, ['handle', 'x', 'y'])
  // It is the one verb that cannot name what it is about to hit. A model that is not told that will
  // reach for it where `click` was the right verb, and lose the check that makes `click` safe.
  assert.match(tool?.description ?? '', /blind/i)
})

test('a capture renders the picture as a second block, and nothing extra when there is none', () => {
  const h = harness()
  apply(h.ctx)
  const shot = h.tools.find((t) => t.name === 'screenshot')
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 4, height: 5 }

  const withPicture = (shot?.output.render({}, { text: 'captured', image: ref }) ?? []) as { type: string }[]
  assert.deepEqual(withPicture.map((b) => b.type), ['text', 'image'])
  assert.deepEqual((withPicture[1] as { attachment: unknown }).attachment, ref)

  // No store, or a model that takes no image: the words stand alone rather than the block list
  // carrying an attachment that was never stored.
  const without = (shot?.output.render({}, { text: 'captured' }) ?? []) as { type: string }[]
  assert.deepEqual(without.map((b) => b.type), ['text'])
})

test('a profile with no governance channel still gets the tools, and says nothing', () => {
  const h = harness({ governance: false })
  apply(h.ctx)

  assert.equal(h.tools.length, 7)
  assert.deepEqual(h.declared, [])
})

test('a context with no service lookup at all is reported, because then it is knowable', () => {
  const h = harness({ inject: false })
  apply(h.ctx)

  assert.equal(h.tools.length, 7)
  assert.ok(h.logs.some((line) => line.includes('not governed by the write guard')))
  assert.ok(h.logs.some((line) => line.includes('cannot offer its manual')))
})

test('a named application list does not disturb the mounting', () => {
  const h = harness()
  apply(h.ctx, { applications: ['Notepad', 'Calculator'] })

  assert.deepEqual(h.tools.map((t) => t.name).sort(), VERBS)
  assert.deepEqual(h.declared.map((d) => d.tool).sort(), VERBS)
})

test('the window list reads as a list a caller can address', () => {
  const text = describeWindows({
    screen: { width: 2160, height: 1440 },
    windows: [
      { handle: 42, title: 'Notepad', class: 'Notepad', pid: 7, width: 800, height: 600, x: 0, y: 0, foreground: true },
      { handle: 99, title: '', class: 'Progman', pid: 4, width: 0, height: 0 },
    ],
    skipped: ['a window that died'],
  })

  assert.match(text, /screen {3}2160 x 1440/)
  assert.match(text, /windows {2}2/)
  assert.match(text, /"Notepad"/)
  assert.match(text, /\(untitled\)/)
  assert.match(text, /\(foreground\)/)
  assert.match(text, /1 window\(s\) could not be read/)
})

test('a truncated read says so, because a caller reading a cut list would think it complete', () => {
  const text = describeWindowState({
    window: { handle: 42, title: 'Notepad', class: 'Notepad', pid: 7 },
    count: 2,
    truncated: true,
    elements: [
      { index: 0, control: 'Document', name: 'Text editor', value: 'hello', enabled: true, width: 10, height: 20, x: 1, y: 2 },
      { index: 1, control: 'Button', name: 'Save', enabled: false, width: 3, height: 4, x: 5, y: 6 },
    ],
  })

  assert.match(text, /elements 2 \(truncated/)
  assert.match(text, /\[  0\] Document {5}"Text editor" = "hello"/)
  assert.match(text, /\[  1\] Button {7}"Save".*\(disabled\)/)
  assert.match(text, /may be past it/)
})

test('a refusal is rendered as a refusal, with what was expected against what is there', () => {
  const text = describeInvoke(
    {
      ok: false,
      refused: 'index-moved',
      detail: 'index 7 is no longer Button/"Save"',
      expected: { control: 'Button', name: 'Save' },
      actual: { index: 7, control: 'Button', name: 'Delete' },
    },
    'click',
  )

  assert.match(text, /REFUSED \(index-moved\)/)
  assert.match(text, /expected Button\/"Save" but index 7 is Button\/"Delete"/)
  assert.match(text, /Nothing was done/)
})

test('a successful act is rendered as what happened, and where', () => {
  const text = describeInvoke({ ok: true, did: "clicked 'Save'", actual: { index: 7, name: 'Save' } }, 'click')
  assert.match(text, /^ok — clicked 'Save' \(index 7, "Save"\)$/)
})

/**
 * A window handle that cannot name a window on any machine.
 *
 * Every call below is aimed at it, so a verb that does get past the gate still changes nothing where
 * these tests run — the same handle `scripts.test.ts` uses for the same reason.
 */
const NO_WINDOW = 999_999_999

const CLICK_ARGS = { handle: NO_WINDOW, index: 3, control: 'Button', name: 'Save' }
const CLICK_AT_ARGS = { handle: NO_WINDOW, x: 12, y: 34 }
const TYPE_ARGS = { handle: NO_WINDOW, index: 3, control: 'Edit', name: 'Name', text: 'hello' }
const PRESS_ARGS = { handle: NO_WINDOW, key: 'ctrl+s' }

/** Each verb the default configuration gates: its call, and what the question it asks must say. */
const GATED: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
  ['click', CLICK_ARGS, /click element 3 \(Button "Save"\) in window 999999999/],
  ['click_at', CLICK_AT_ARGS, /click at screen point 12,34 in window 999999999/],
  ['type_text', TYPE_ARGS, /type 5 character\(s\) into element 3 \(Edit "Name"\) in window 999999999/],
  ['press_key', PRESS_ARGS, /press "ctrl\+s" in window 999999999/],
]

const ONLY_WINDOWS = { skip: process.platform !== 'win32' ? 'Windows-only capability' : false }

/** A stand-in for the host's approval service: it records what it was asked and answers as told. */
function fakeApproval(answer: ApprovalOutcome | Error): {
  surface: ApprovalSurface
  asked: Parameters<ApprovalSurface['request']>[0][]
} {
  const asked: Parameters<ApprovalSurface['request']>[0][] = []
  return {
    asked,
    surface: {
      async request(request) {
        asked.push(request)
        if (answer instanceof Error) throw answer
        return answer
      },
    },
  }
}

/**
 * Call one verb the way the registry does, and report a throw rather than propagating it.
 *
 * What runs after the gate opens is `powershell.exe`, and a machine with none is not what any of
 * these tests is about — so a failure past the gate comes back as `error`, and the call's text comes
 * back as nothing, which is itself the signal a gate leaked.
 */
async function attempt(
  tool: Harness['tools'][number] | undefined,
  args: Record<string, unknown>,
  exec: ExecutionContext = {},
): Promise<{ text?: string | undefined; error?: unknown }> {
  assert.ok(tool !== undefined, 'the verb must be registered')
  try {
    return { text: ((await tool.execute(args as never, exec)) as { text?: string }).text }
  } catch (error) {
    return { error }
  }
}

test('the first act asks once, and opens the desktop for the session it was asked in', async () => {
  // The unit of approval is the capability, not the verb: four acts by one agent are one question,
  // because a question per click is a question the person answering stops reading — and a
  // confirmation nobody reads only teaches them to click through.
  const service = fakeApproval('allowed-once')
  const h = harness({ approval: service.surface })
  apply(h.ctx, { applications: ['Notepad', 'Calculator'] })
  const exec: ExecutionContext = { agent: { options: { provider: 'p', model: 'm' } } }

  for (const [verb, args] of GATED) {
    await attempt(h.tools.find((t) => t.name === verb), args, exec)
  }

  assert.equal(service.asked.length, 1, 'four acts by one agent are one question')
  const question = service.asked[0]
  // Asked on the agent's behalf, which is how the host routes it to that session's answerer.
  assert.equal(question?.agent, exec.agent)
  // The question is about the capability, and it carries the scope: "yes" to a click is not the same
  // answer as "yes to this session on these windows", and the person has to know which one they give.
  assert.match(question?.reason ?? '', /operate the desktop for this session/)
  assert.match(question?.reason ?? '', /windows: Notepad, Calculator/)
  assert.match(question?.reason ?? '', /without asking again/)
  // And it names the act that prompted it, so the answer is about something rather than about a verb.
  assert.match(question?.reason ?? '', /First act: \S+/)
  // The log says the gate opened and for what, so whoever reads the server log is not left guessing.
  assert.ok(
    h.logs.some((line) => line.includes('approved for this session') && line.includes('Notepad')),
    'a gate that opened says so, and says for what',
  )

  // Reading is not acting: the three verbs that only look never ask, which is what makes "read the
  // window, then act" a workflow rather than a prompt.
  for (const verb of ['list_windows', 'get_window_state', 'screenshot']) {
    service.asked.length = 0
    await attempt(h.tools.find((t) => t.name === verb), { handle: NO_WINDOW }, exec)
    assert.deepEqual(service.asked, [], `${verb} only looks, so it must not ask`)
  }
})

test('a granted approval really runs the script, and a refused one does not', ONLY_WINDOWS, async () => {
  // The differential, and the only thing that proves the gate stands in front of the script rather
  // than beside it: the same call, once approved and once refused. Approved, it reaches PowerShell
  // and comes back with the script's own refusal — the handle names no window, so nothing on this
  // desktop is touched either way.
  const granted = fakeApproval('allowed-once')
  const open = harness({ approval: granted.surface })
  apply(open.ctx)
  const ran = await attempt(open.tools.find((t) => t.name === 'click'), CLICK_ARGS)
  assert.match(ran.text ?? '', /REFUSED \(window-gone\)/)

  const denied = fakeApproval('rejected')
  const shut = harness({ approval: denied.surface })
  apply(shut.ctx)
  const stopped = await attempt(shut.tools.find((t) => t.name === 'click'), CLICK_ARGS)
  assert.match(stopped.text ?? '', /NOT APPROVED \(rejected\)/)
  assert.doesNotMatch(stopped.text ?? '', /REFUSED \(/)
})

test('a refusal, a withdrawal, and an answerer that is not there read as three different things', async () => {
  const texts: string[] = []

  for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
    const service = fakeApproval(outcome)
    const h = harness({ approval: service.surface })
    apply(h.ctx)
    const result = await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS)

    // Text and not an exception: the model has to read the refusal and explain it to the user.
    assert.equal(result.error, undefined, `${outcome} must be answered with a sentence`)
    assert.match(result.text ?? '', new RegExp(`NOT APPROVED \\(${outcome}\\)`))
    // And the act did not run, which is what "not approved" has to mean.
    assert.doesNotMatch(result.text ?? '', /REFUSED \(|window-gone/)
    texts.push(result.text ?? '')
  }

  assert.equal(new Set(texts).size, 3, 'three endings are three different messages')
  // The distinction that matters most of all: "the user said no" is not "there was nobody to ask",
  // and a model that confuses them tells the user they refused something they were never shown.
  assert.match(texts[0] ?? '', /Do not repeat it unchanged/)
  assert.match(texts[1] ?? '', /withdrawn/)
  assert.match(texts[2] ?? '', /no answerer/)
})

test('a verb that must be approved is refused when there is nothing to ask', async () => {
  // Both shapes of "no approval service": a context with no lookup at all, and one whose lookup
  // answers undefined. Neither may open the gate, which is the host's own rule — a caller fails
  // closed on a question nobody answered, including one nobody could be asked.
  for (const approval of [undefined, null] as const) {
    const h = harness({ approval })
    apply(h.ctx)
    const result = await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS)

    assert.equal(result.error, undefined)
    assert.match(result.text ?? '', /NOT APPROVED \(no-approval-service\)/)
    assert.doesNotMatch(result.text ?? '', /REFUSED \(/)
  }
})

test('an ask that throws is a refusal, not a crash the model would read as a broken tool', async () => {
  // The host throws when the question has nowhere to go — no open turn, no session to log it on.
  // That is a reason not to act, and it must not arrive as a defect in the tool.
  const service = fakeApproval(new Error('approval.request() outside an open turn'))
  const h = harness({ approval: service.surface })
  apply(h.ctx)
  const result = await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS)

  assert.equal(result.error, undefined, 'a throwing ask must not become a throwing tool')
  assert.match(result.text ?? '', /NOT APPROVED \(ask-failed\)/)
  assert.match(result.text ?? '', /outside an open turn/)
})

test('a deployment that switches the gate off is never asked', async () => {
  // The escape hatch, and it has to be written deliberately: `requireApproval: false` is a
  // deployment deciding these acts need no consent, and then the gate does not exist.
  const service = fakeApproval('rejected') // it would refuse, if it were ever asked
  const h = harness({ approval: service.surface })
  apply(h.ctx, { requireApproval: false })
  const result = await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS)

  assert.deepEqual(service.asked, [])
  assert.doesNotMatch(result.text ?? '', /NOT APPROVED/)
})

test('a second agent is asked on its own first act, and an unidentified caller opens nothing', async () => {
  // A session is one agent. The second agent in the same process was not party to the first one's
  // answer, and a call that arrives with no agent at all cannot be attributed to anyone — so it asks
  // every time rather than opening a gate nobody is answerable for.
  const service = fakeApproval('allowed-once')
  const h = harness({ approval: service.surface })
  apply(h.ctx)
  const click = () => h.tools.find((t) => t.name === 'click')
  const first: ExecutionContext = { agent: {} }
  const second: ExecutionContext = { agent: {} }

  await attempt(click(), CLICK_ARGS, first)
  await attempt(click(), CLICK_ARGS, first)
  assert.equal(service.asked.length, 1, 'the first agent asked once and acted twice')

  await attempt(click(), CLICK_ARGS, second)
  assert.equal(service.asked.length, 2, 'the second agent was not party to the first answer')

  await attempt(click(), CLICK_ARGS, {})
  await attempt(click(), CLICK_ARGS, {})
  assert.equal(service.asked.length, 4, 'a call with no agent opens nothing')
})

test('the gate remembers the agent the host names, not the object it happens to hand over', async () => {
  // The shape the host actually dispatches with: a live agent carrying an `id`, which is its session.
  // Two calls in one session may arrive as two different objects — a wrapper rebuilt per call would
  // defeat keying on object identity — so the name is what the gate remembers. The first version of
  // this gate keyed on `agentId`, which the host never sets, and asked again on every act.
  const service = fakeApproval('allowed-once')
  const h = harness({ approval: service.surface })
  apply(h.ctx)
  const click = () => h.tools.find((t) => t.name === 'click')

  await attempt(click(), CLICK_ARGS, { agent: { id: 'session-1' } })
  await attempt(click(), CLICK_ARGS, { agent: { id: 'session-1' } })
  assert.equal(service.asked.length, 1, 'the same named session is the same answer')

  await attempt(click(), CLICK_ARGS, { agent: { id: 'session-2' } })
  assert.equal(service.asked.length, 2, 'another session is another question')
})

test('the approval service is looked up when the verb runs, not when the plugin is mounted', async () => {
  // The recorded pitfall this pin is about: a plugin that resolved the service during `apply` would
  // hold whatever was mounted at load time — and would refuse every act in a profile that mounts the
  // approval service after it, which is a gate that fails closed for the wrong reason.
  const options: { approval?: ApprovalSurface | null } = {}
  const h = harness(options)
  apply(h.ctx)

  const service = fakeApproval('allowed-once')
  options.approval = service.surface // the profile mounts it after this plugin, as it does in practice

  await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS)
  assert.equal(service.asked.length, 1, 'the service that is mounted when the verb runs is the one asked')
})

test('a refusal opens nothing, and a deployment that named no windows is told what it is approving', async () => {
  // A question answered "no" is not a question answered "yes": the session stays closed and the next
  // act asks again rather than inheriting an answer it was never given.
  const service = fakeApproval('rejected')
  const h = harness({ approval: service.surface })
  apply(h.ctx)
  const one: ExecutionContext = { agent: {} }

  await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS, one)
  await attempt(h.tools.find((t) => t.name === 'click'), CLICK_ARGS, one)
  assert.equal(service.asked.length, 2, 'a refusal leaves the gate exactly where it was')

  // And with no `applications` named, the answer covers every window on the machine — which the
  // question says out loud, rather than leaving it to be discovered by what the agent then does.
  assert.match(service.asked[0]?.reason ?? '', /every window on this machine/)
})
