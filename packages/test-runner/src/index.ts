/**
 * Running a project's tests and reading what the run said.
 *
 * An ability of the kind that acts on the world rather than describing it. Two tools, and they are
 * two halves of one thing — running without reading the result tells you nothing, and reading a
 * report you did not produce tells you less. A capability is one of these, not one per tool.
 *
 * What this plugin deliberately does not do: **it does not write the ontology.** It produces facts
 * and hands them back, and recording them is the domain's business — the domain declares a
 * `record_test_run` action and a role permitted to call it. The separation is what lets this
 * plugin be installed into any deployment whose tests are run this way, and it is why the module
 * imports nothing from the ontology package: a capability that knew what a `TestRun` was would
 * have to know the customer's world.
 *
 * @module @zhangcun123/test-runner
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'

import { parseJunit, triage, type JunitCase, type JunitSummary } from './junit.ts'
import { runCommand, type RunOutcome } from './run.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-test-runner'

/** Declared so the loader holds this plugin until the tool registry exists. */
export const inject = ['tools']

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config {
  /** Directory the tests run in. Empty means the plugin registers nothing and says so. */
  workspace?: string
  /**
   * The command, with an optional `{target}` slot the model may fill.
   *
   * A template rather than a bare command because a test agent has to be able to run a subset, and
   * the safe way to allow that is to name the slot in advance and validate what goes into it. The
   * alternative — appending a caller's string to a command — is how a test runner becomes a shell.
   */
  command?: string
  /** Seconds before the run is killed, tree and all. */
  timeoutSeconds?: number
}

/** A registered tool, in the shape the runtime's registry accepts. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  execute: (args: never, exec: { agentId?: string }) => Promise<unknown>
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface TestRunnerContext {
  tools: { register(tool: RegisteredTool): void }
  logger?: { warn(message: string): void }
  /**
   * Look up a service by name once a context carrying it exists.
   *
   * Used for one thing: telling the governance plugin what these tools touch. Optional and looked
   * up by name rather than imported, because a capability has to load with no governance plugin at
   * all — and then it is simply a tool nobody is judging, which this plugin says out loud.
   */
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
}

/** The declaration channel, as the governance plugin publishes it. */
export interface GovernanceSurface {
  declareTool(
    name: string,
    access: { writes?: readonly string[]; executes?: readonly string[]; commands?: readonly string[] },
  ): () => void
}

/** The name both packages state rather than import. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

const DEFAULT_COMMAND = 'python -m pytest -q --junitxml=.junit.xml {target}'
const JUNIT_FILE = '.junit.xml'

/** A target is a relative path and nothing else: no shell metacharacters, no climbing out. */
const SAFE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_./\\-]*$/

/** Reject a target that could mean something other than "this file, in here". */
function safeTarget(target: string, workspace: string): string | undefined {
  if (target.length === 0) return undefined
  if (!SAFE_TARGET.test(target)) return undefined
  if (target.split(/[\\/]/).includes('..')) return undefined
  const resolved = normalize(join(workspace, target))
  const inside = normalize(workspace)
  const relation = relative(inside, resolved)
  if (relation.startsWith('..') || isAbsolute(relation)) return undefined
  return target
}

/** Everything one run produced: what happened, and what the report said about it. */
export interface RunReport extends RunOutcome {
  /** The parsed report, when the run wrote one. */
  junit?: JunitSummary
  /** Where the report was looked for, so a caller knows what was not found. */
  junitPath?: string
  /** Why there is no report, when there is not one. */
  junitMissing?: string
}

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  // `required` belongs to the object, not to the property. Nested inside `text` it is not a
  // constraint the host understands and it rejects the whole schema — which took the plugin's
  // `apply` down with it, so the bundle loaded as nothing at all. The eight unit tests never saw
  // this: they call `runCommand` and `parseJunit` directly and never go through `register`.
  required: ['text'],
} as const

/** One case, as a line: the outcome, and what kind of wrong when that is known. */
function caseLine(entry: JunitCase): string {
  const label = entry.kind === undefined ? entry.status : `${entry.status}(${entry.kind})`
  return `  ${label.padEnd(20)} ${entry.tcId ?? entry.name}`
}

/** The summary as lines, in the order a reader wants them. */
function describe(report: RunReport): string {
  const lines: string[] = []
  const verdict = report.timedOut
    ? `timed out after ${report.seconds}s`
    : report.exitCode === 0
      ? 'passed'
      : `exit ${report.exitCode ?? 'unknown'}`
  lines.push(`run      ${verdict} in ${report.seconds}s`)
  lines.push(`command  ${report.command}`)
  lines.push(`cwd      ${report.cwd}`)

  if (report.junit === undefined) {
    lines.push(`junit    none — ${report.junitMissing ?? 'not found'}`)
  } else {
    const j = report.junit
    lines.push(
      `junit    ${j.total} cases: ${j.passed} passed, ${j.failed} failed, ${j.error} error, ${j.skipped} skipped`,
    )
    // Errors before failures: a test that never ran is where a reader should start.
    for (const entry of triage(j).slice(0, 20)) {
      lines.push(caseLine(entry))
      if (entry.detail !== undefined) lines.push(`        ${entry.detail}`)
    }
    if (triage(j).length > 20) lines.push(`  … and ${triage(j).length - 20} more not shown`)
  }

  if (report.stdout.trim().length > 0) lines.push('', 'stdout', report.stdout.trimEnd())
  if (report.stderr.trim().length > 0) lines.push('', 'stderr', report.stderr.trimEnd())
  if (report.truncated) lines.push('', 'NOTE: output was cut; what is missing is large.')
  return lines.join('\n')
}

/**
 * Register the capability's tools.
 *
 * @param ctx - The runtime context.
 * @param config - Where the tests are and how to run them.
 */
export function apply(ctx: TestRunnerContext, config: Config = {}): void {
  const workspace = config.workspace ?? ''
  const command = config.command === undefined || config.command.length === 0 ? DEFAULT_COMMAND : config.command
  const timeoutSeconds = config.timeoutSeconds ?? 600
  const warn = (message: string): void => ctx.logger?.warn(message)

  if (workspace.length === 0) {
    // Nothing to run in, so nothing to offer. Said out loud rather than registering a tool that
    // would fail on its first call — an unconfigured deployment should read as unconfigured.
    warn('test-runner: no workspace configured; no tool is registered')
    return
  }
  if (!command.includes('{target}')) {
    warn(
      'test-runner: the command has no {target} slot, so a caller cannot narrow a run; ' +
        'the tool still works, every call being the whole suite',
    )
  }

  ctx.tools.register({
    name: 'run_tests',
    description:
      'Run the project\u2019s test command in the configured workspace, then read the report it ' +
      'wrote. Returns the exit status, the output, and a per-case breakdown that separates a ' +
      'failing assertion from an error that never reached one. This reports facts; recording them ' +
      'in the ontology is a separate, governed write.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          description:
            'A test file or directory to run instead of everything, relative to the workspace ' +
            '(e.g. tests/test_order.py). No absolute paths and no .. .',
        },
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args: { target?: string }): Promise<unknown> {
      let slot = ''
      if (args.target !== undefined && args.target.length > 0) {
        const safe = safeTarget(args.target, workspace)
        if (safe === undefined) {
          throw new Error(
            `target "${args.target}" is not a relative path inside the workspace; ` +
              'give a plain path like tests/test_order.py',
          )
        }
        slot = safe
      }

      const report = await runCommand({
        command: command.replaceAll('{target}', slot),
        cwd: workspace,
        timeoutSeconds,
      })

      const junitPath = join(workspace, JUNIT_FILE)
      const outcome: RunReport = { ...report, junitPath }
      if (existsSync(junitPath)) {
        try {
          outcome.junit = parseJunit(readFileSync(junitPath, 'utf8'))
        } catch (error) {
          outcome.junitMissing = `a report exists at ${junitPath} but could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      } else {
        outcome.junitMissing = `${JUNIT_FILE} was not written in ${workspace}`
      }

      return { text: describe(outcome) }
    },
  })

  ctx.tools.register({
    name: 'parse_junit',
    description:
      'Read a junit report that already exists, without running anything. Use it to re-read a ' +
      'previous run, or to inspect a report produced elsewhere.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: `Report to read, relative to the workspace. Defaults to ${JUNIT_FILE}.`,
        },
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args: { path?: string }): Promise<unknown> {
      const requested = args.path === undefined || args.path.length === 0 ? JUNIT_FILE : args.path
      const safe = safeTarget(requested, workspace)
      if (safe === undefined) {
        throw new Error(`path "${requested}" is not a relative path inside the workspace`)
      }
      const full = join(workspace, safe)
      if (!existsSync(full)) throw new Error(`no report at ${full}`)

      const summary = parseJunit(readFileSync(full, 'utf8'))
      const lines = [
        `report   ${full}`,
        `junit    ${summary.total} cases: ${summary.passed} passed, ${summary.failed} failed, ` +
          `${summary.error} error, ${summary.skipped} skipped`,
      ]
      for (const entry of triage(summary)) {
        lines.push(caseLine(entry))
        if (entry.detail !== undefined) lines.push(`        ${entry.detail}`)
      }
      return { text: lines.join('\n') }
    },
  })

  // What these tools touch, told to the plugin that judges them — and told rather than known,
  // because that plugin has never heard of `run_tests` and should not have to.
  //
  // `executes` and not `writes`: running a project's tests runs whatever is in the target, and the
  // target need not sit inside the domain at all. A directory rule borrowed from the domain would
  // refuse the ordinary case of testing a project, so a tool that runs code is authorised by the
  // domain's grant alone — and a domain that has not granted it to anybody gets a refusal rather
  // than a free pass.
  const governance = ctx.inject
  if (governance === undefined) {
    warn(
      'the runtime exposes no service lookup, so run_tests cannot declare what it touches and is ' +
        'not governed by the write guard',
    )
  } else {
    // The callback receives a context carrying the service, not the service itself — the same shape
    // the host's own plugins use (`inner.systemPrompt.section(...)`). Reading it as the value
    // compiled, and then called a method on a context that does not have one.
    governance([GOVERNANCE_SERVICE], (scoped: Record<string, GovernanceSurface>) => {
      scoped[GOVERNANCE_SERVICE]?.declareTool('run_tests', { executes: ['target'] })
    })
  }
}
