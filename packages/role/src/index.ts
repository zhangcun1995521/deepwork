/**
 * @zhangcun123/role — the plugin.
 *
 * The role a mode acts as, and the prompt it works under. It registers no tools, which is the point:
 * a mount that costs nothing and duplicates nothing is what lets a mode state who its agents are
 * without a second mount of anything else.
 *
 * It states that role to the reader of a prompt and to nobody else. It used to publish it as a
 * service the ontology could select rules by, and that channel was deleted rather than repaired: a
 * preset's rows are mounted in the preset's own realm, so a row that publishes a service publishes
 * into that realm, and the ontology is mounted by the profile, outside it. A host-plane consumer
 * never receives it. Worse, a preset row that publishes into the ROOT realm has its whole preset
 * rejected ("Preset services require isolate realms") — which the interface renders as a mode that is
 * simply absent, with nothing written to any log. Which role a deployment acts as is stated where the
 * ontology is mounted, as the `situation` tag the domain selects rules by; a mode states it here only
 * to pick the prompt its own agents work under.
 *
 * @module @zhangcun123/role
 */

import { readFileSync } from 'node:fs'

/** Plugin name, as the runtime's loader sees it in logs and error messages. */
export const name = 'deepwork-role'

/**
 * The services this plugin requires before it starts, declared the way the loader reads them.
 *
 * The prompt registry is the one thing this row cannot do its work without, and
 * `@deepseek-ai/dsh-persona` declares exactly this one while being mounted in the same list by every
 * preset — which is the evidence that a row inside a preset resolves it. Our own `test-runner`
 * declares `['tools']` for the same reason.
 *
 * Declaring it is the honest of the two options. An undeclared requirement still comes up and mounts
 * no section, so the agent silently loses its prompt; a declared one the composition does not supply
 * is reported as an unusable row, which takes the mode out of the picker — a real failure, though one
 * the registry reports nowhere but the picker itself. Either way the answer is a composition that
 * supplies `systemPrompt`, and this says so in the file rather than in a comment.
 */
export const inject = ['systemPrompt']

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config {
  /**
   * The role this mount acts as, when the composition states one.
   *
   * It selects which prompt below is mounted, and nothing else. Left unset, nothing changes: no
   * prompt is mounted and the mode acts as no stated role.
   *
   * Deliberately **not** a deployment's role map, which answers "who is this caller" for the write
   * path. That one has to fail closed and is a security decision; this one is a fact about how a mode
   * is composed. A deployment that wants both states both, and conflating them would mean a mode
   * could grant itself write authority by naming a role.
   */
  role?: string
  /**
   * Prompts to mount, by role: an absolute path to a text file per role.
   *
   * The half of a mode that has no other home. "You are the testing agent and this is your job" is a
   * sentence about one agent, and a composition is the only place that can say it — a domain
   * describes the enterprise, not the agent. It is a file rather than a config string because a
   * prompt is prose somebody edits and reviews, not a value somebody types into YAML.
   *
   * `role` selects the entry. A missing file, or a role with no entry, is reported and the mode comes
   * up without a prompt rather than failing to load: a missing prompt degrades an agent's manner, and
   * refusing to boot over it would take the tools down with it.
   */
  prompts?: Record<string, string>
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface RoleContext {
  logger?: {
    warn(message: string): void
  }
  /**
   * Run `callback` once a context carrying the named services exists, or never if it never does.
   * Optional, and deliberately so: a profile may have no prompt registry, and this plugin must still
   * come up in one that has none.
   */
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
}

/** The prompt registry a profile provides, when it has one. */
export interface SystemPromptSurface {
  systemPrompt: {
    /**
     * Register one ordered section. A duplicate name in one layer throws, so the name is the
     * plugin's own and namespaced; the host's own sections are named by the host.
     */
    section(section: {
      name: string
      order: number
      /** Static text, or a provider evaluated for each assembly. */
      text: string | (() => string)
      /** False keeps the text literal, which matters when it comes from a file nobody here wrote. */
      interpolate?: boolean
    }): () => void
    /** The centrally allocated position for a named section. */
    getSectionOrder(name: string): number
  }
  /** Tie the registration to this plugin's lifetime, the way the web route is tied. */
  effect?(callback: () => () => void, label?: string): void
}

/** Report a problem on whichever channel is available. */
function warn(ctx: RoleContext, message: string): void {
  if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
  else process.stderr.write(`[${name}] ${message}\n`)
}

/**
 * State the role this mount acts as, and mount the prompt for it.
 *
 * Nothing here throws. An unreadable prompt and an absent one are the same outcome on purpose: a
 * prompt is the one part of a mode whose absence degrades manner rather than capability, so the mode
 * comes up either way and says what happened.
 */
export function apply(ctx: RoleContext, config: Config = {}): void {
  const role = config.role ?? ''
  if (role.length === 0) {
    warn(ctx, 'no role configured; no prompt is mounted')
    return
  }

  const promptFile = config.prompts?.[role]
  if (promptFile === undefined) {
    warn(
      ctx,
      `this mount acts as role "${role}" and declares no prompts entry for it, so no prompt ` +
        'is mounted',
    )
    return
  }

  let text: string
  try {
    text = readFileSync(promptFile, 'utf8')
  } catch (error) {
    warn(
      ctx,
      `the prompt for role "${role}" could not be read from ${promptFile} ` +
        `(${error instanceof Error ? error.message : String(error)}); the mode comes up without ` +
        'it, and its tools are unaffected',
    )
    return
  }
  if (text.trim().length === 0) {
    warn(ctx, `the prompt for role "${role}" at ${promptFile} is empty; nothing mounted`)
    return
  }

  // Registered as its own section rather than through the persona registry, and the reason is the
  // one a composition already ran into: a deployment persona row and a role prompt would both be
  // writing to the agent's identity, and two registrations of one name in one layer throw. A
  // distinct name sidesteps that and says what the block is, which `deployment:persona-prefix`
  // would not — this prompt is about *this role in this mode*, and it arrives beside the rules that
  // role must follow rather than instead of the deployment's own persona.
  ctx.inject?.(['systemPrompt'], (prompt: SystemPromptSurface) => {
    prompt.effect?.(
      () =>
        prompt.systemPrompt.section({
          name: 'deepwork:role-prompt',
          // Ahead of the rules and behind the deployment's own persona: who this agent is, then
          // what it must follow, then the tools.
          order: prompt.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
          // A prompt is prose, and prose contains braces. The registry's `{{variable}}` references
          // are strict, so interpolating text written outside this repository would be a way for a
          // prompt to fail every turn.
          interpolate: false,
          text,
        }),
      'deepwork-role: role prompt',
    )
  })
}
