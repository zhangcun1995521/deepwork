/**
 * @zhangcun123/git — "operate one repository", split into segments the guard can govern.
 *
 * The reason this package exists is not "an agent needs to run git" — it can already do that through a
 * shell. It is:
 *
 *   1. **Risk is separated.** `git log` and `git push --force` have the same authority inside one shell
 *      tool. Split into tools, authority, audit and refusal all key on a tool name, so a domain can say
 *      "who may publish".
 *   2. **The dangerous actions have no entry point.** Force push, reset --hard, clean, filter-branch are
 *      not "forbidden and require approval" — they are not offered.
 *   3. **Paths stay inside** the one repository the deployment configured.
 *   4. **Size is a gate.** A change over N lines is refused rather than published: a diff too large to
 *      read is one nobody reviews properly.
 *
 * What it declares to the guard: every tool `executes: ['git']` (they all spawn git), and the two that
 * write also declare `writes: [root]`.
 *
 * @module @zhangcun123/git
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GitRefusal, isRepository, repositoryRoot } from './repo.ts'
import { buildGitTools, type GitTool } from './tools.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-git'

/** Requires the tool registry. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Repository root. Empty means no tool is registered, and the reason is said out loud. */
  root?: string
  /** Allow pushing. Default false — a capability that can publish on install defaults to "no". */
  allowPush?: boolean
  /** Refuse a push whose pending change exceeds this many lines. Default 400. */
  maxDiffLines?: number
  /** Per-command timeout in milliseconds. Default 60 seconds. */
  timeoutMs?: number
}

/**
 * The shape of the capability note the skill registry accepts.
 *
 * Why this package needs a skill and `lsp` does not: a tool description fits "what this action does"
 * and nothing else. It cannot carry the order to work in, the substitute for an action that is not
 * offered, or where to stop when something fails. git needs all three, and prose is the only form they
 * fit in.
 */
export interface GitSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
  source: 'runtime'
}

/** The skill registry, as the host publishes it. */
export interface SkillSurface {
  skills: { register(skill: GitSkill): () => void }
  effect?(callback: () => () => void, label?: string): void
}

/** The governance channel, stated by name rather than imported. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

/**
 * Read the shipped SKILL.md.
 *
 * @returns The skill, or undefined when the file is missing — a missing note must not stop the tools
 *   from loading; it only means the model has to guess at the order.
 */
function readSkill(): GitSkill | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  // Both `lib/index.js` and `src/index.ts` have to find the file at the package root.
  for (const candidate of [join(here, '..', 'SKILL.md'), join(here, '..', '..', 'SKILL.md')]) {
    try {
      const content = readFileSync(candidate, 'utf8')
      return {
        name: 'git-workflow',
        description:
          'How to use the git tools: the default path (an isolated worktree from origin/main), what to do ' +
          'instead when the action you want is not offered, and where to stop when something fails.',
        whenToUse:
          'Before the first git action in a task, and again when a git action was refused or a merge conflicted.',
        content,
        source: 'runtime',
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** The governance surface this plugin declares into. */
export interface GovernanceSurface {
  declareTool(
    name: string,
    access: { writes?: readonly string[]; executes?: readonly string[]; commands?: readonly string[] },
  ): () => void
}

/** The runtime context, structural and therefore host-free. */
export interface GitContext {
  tools: { register(tool: GitTool): void }
  logger?: { warn(message: string): void; info?(message: string): void }
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
}

/** Mount the capability. */
export function apply(ctx: GitContext, config: Config = {}): void {
  const warn = (message: string): void => ctx.logger?.warn(message)
  const configured = config.root ?? ''

  if (configured.length === 0) {
    warn(
      'git: no repository root configured, so no git tool is registered. Point config.root at the repository ' +
        'an agent is allowed to work in — a capability that would pick a repository by itself is one nobody reviewed',
    )
    return
  }

  const root = resolve(configured)
  if (!isRepository(root)) {
    warn(`git: ${root} is not a git repository, so no git tool is registered`)
    return
  }

  let repository: string
  try {
    repository = repositoryRoot(root)
  } catch (error) {
    warn(`git: ${root} could not be read as a repository (${error instanceof Error ? error.message : String(error)})`)
    return
  }

  const tools = buildGitTools({
    root: repository,
    ...(config.allowPush === undefined ? {} : { allowPush: config.allowPush }),
    ...(config.maxDiffLines === undefined ? {} : { maxDiffLines: config.maxDiffLines }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })

  const registered: string[] = []
  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
      registered.push(tool.name)
    } catch (error) {
      // One failed registration must not take the other two down: reading is still useful.
      warn(`git: ${tool.name} was not registered — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // What the guard is told: all three spawn git; the two that write also declare the path they write.
  const governance = ctx.inject
  if (governance === undefined) {
    warn(
      'git: the runtime exposes no service lookup, so these tools cannot declare what they run and are not ' +
        'governed by the write guard',
    )
  } else {
    governance<Record<string, GovernanceSurface>>(['deepworkGovernance'], (scoped) => {
      const surface = scoped[GOVERNANCE_SERVICE]
      if (surface === undefined) return
      for (const tool of registered) {
        surface.declareTool(
          tool,
          tool === 'git_read' ? { executes: ['git'] } : { executes: ['git'], writes: [repository] },
        )
      }
    })
  }

  // The capability note: loaded on demand, never carried in the prompt. A composition without a skill
  // registry still works; the model simply has less to go on.
  if (ctx.inject === undefined) {
    warn('git: the runtime exposes no service lookup, so the git workflow skill is not registered')
  } else {
    ctx.inject<SkillSurface>(['skills'], (registry) => {
      const skill = readSkill()
      if (skill === undefined) {
        warn('git: SKILL.md was not found next to the package, so the git workflow skill is not registered')
        return
      }
      const register = (): (() => void) => registry.skills.register(skill)
      if (typeof registry.effect === 'function') registry.effect(register, 'deepwork-git: workflow skill')
      else register()
    })
  }

  const pushing = config.allowPush === true ? 'pushing is enabled' : 'pushing is disabled'
  ctx.logger?.info?.(
    `git: ${registered.length} tool(s) on ${repository} (${pushing}` +
      `${config.maxDiffLines === undefined ? '' : `, publish limit ${config.maxDiffLines} lines`})`,
  )
}

export { GitRefusal, FORBIDDEN_PATTERNS, diffLineCount, currentBranch, isClean } from './repo.ts'
export type { GitTool, GitToolResult } from './tools.ts'
