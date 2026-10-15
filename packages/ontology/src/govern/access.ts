/**
 * What a tool touches, declared by the tool that knows — and who may call it.
 *
 * The guard used to recognise tools by name. `write` and `edit` were a constant, `bash` and `pwsh`
 * were another, and a tool in neither was let through without being looked at. That works for the
 * host's own tools, which the guard's author could enumerate, and fails for every tool a capability
 * adds: the capability is a separate package, the guard has never heard of it, and the failure is
 * silent. A capability that runs a project's tests walked past a boundary that refuses the same
 * write made through `write`.
 *
 * So a tool says what it touches and the guard reads the declaration. Two halves, and both are
 * needed:
 *
 *   - **what it touches** — argument names holding a path it writes or a command line, and the
 *     names of the programs it starts. Declared by the tool, because only the tool knows its own
 *     arguments and its own configuration.
 *   - **who may call it** — declared by the domain, because only the deployment knows who is
 *     allowed. A tool that touches something outside the domain has no directory rule to be judged
 *     by; the grant is the whole of its authority, and a tool that declares itself and is granted
 *     to nobody is refused.
 *
 * For a tool that runs code, the grant that carries the authority is keyed by **program name**,
 * not by tool name. Which program runs is decided by deployment configuration — one entry in a
 * servers table or a command template — so a grant that said only "this role may call this tool"
 * would let the same tool start a different program by a config edit nobody reviews. The entry
 * under the tool's own name still exists, but as a narrowing: the domain may write one to restrict
 * the tool further than its programs are restricted, and a domain that writes none has said all it
 * needs to.
 *
 * The direction of failure matters. A tool that declares nothing is not governed — that is the
 * limit this cannot close from here, and it is stated rather than papered over. But a tool that
 * declares itself and finds no grant is **denied**, because "nobody said who may call this" is a
 * worse answer to give an execution tool than "no". And the declaration itself is still the tool's
 * own word: nothing checks that a tool declaring it runs `pytest` actually spawns `pytest`, which
 * is why the program names below are read from the deployment's configuration wherever the tool
 * has any, rather than written by hand where they could drift from it.
 *
 * @module @zhangcun123/ontology/govern/access
 */

/**
 * The service name capabilities look up to declare their tools.
 *
 * A bare string rather than an imported symbol, because the whole point is that the two packages do
 * not depend on each other: a capability may be mounted with no governance plugin at all, and the
 * plugin may load with no capabilities. Where they meet is a name both sides state.
 */
export const GOVERNANCE_SERVICE = 'deepworkGovernance'

/** What one tool touches when it runs. */
export interface ToolAccess {
  /** Argument names whose value is a path this tool writes. */
  readonly writes?: readonly string[]
  /**
   * The names of the programs this tool starts, each one an executable's name.
   *
   * A name here is the basename of a command the deployment configured, not an argument name,
   * because the question the guard asks about these is "which program is allowed to run", and
   * that is decided by configuration the guard never sees otherwise. Kept apart from `writes`
   * because the two are judged differently: a write is checked against the directories the
   * caller's role may write, while a program need not touch the domain at all and is authorised
   * by the grant keyed under its own name.
   */
  readonly executes?: readonly string[]
  /** Argument names whose value is a command line this tool runs. */
  readonly commands?: readonly string[]
}

/** What the guard needs to know about any one tool. */
export interface ToolGovernance {
  /** What the tool touches, from its own declaration or from the built-in table. */
  readonly access: ToolAccess
  /**
   * Roles granted each program this tool runs, keyed by program name, when the domain declares any.
   *
   * A key is present only for a program with a `tool_grants` entry: a missing key is the "nobody
   * said who may run this" case the guard refuses on. This is the required half of a code-running
   * tool's authority; an entry under the tool's own name, in {@link ToolGovernance.grantedTo},
   * only narrows it.
   */
  readonly programGrants?: Readonly<Record<string, readonly string[]>>
  /**
   * Roles granted this tool by name, when the domain declares any.
   *
   * `undefined` is not "nobody" and not "everybody": it means the domain said nothing, and what
   * that implies depends on what the tool touches — see {@link ToolGovernance}.
   */
  readonly grantedTo?: readonly string[]
  /** Where the access came from, so a reader can tell a declaration from a default. */
  readonly source: 'declared' | 'built-in'
}

/** The channel: tools declare, the guard reads. */
export interface GovernanceRegistry {
  /** Declare what a tool touches. Returns the disposer that withdraws it. */
  declareTool(name: string, access: ToolAccess): () => void
  /** Who may call each tool, as the domain declared it. Replaced wholesale on reload. */
  setGrants(grants: ReadonlyMap<string, readonly string[]>): void
  /** Everything the guard can judge about a tool, or `undefined` when it can judge nothing. */
  govern(tool: string): ToolGovernance | undefined
  /** Every tool reached through a declaration, for the boot log. */
  declared(): string[]
}

/**
 * Access for the tools that ship with the host.
 *
 * A table rather than a list of names in the guard, so that the guard has one way of learning
 * about a tool and not two. It stays a table here because the host's tools are not ours to declare:
 * nothing calls `declareTool` for `write`. A capability may declare over an entry — the same tool
 * name declared by the package that owns it wins.
 */
export const BUILT_IN_ACCESS: Readonly<Record<string, ToolAccess>> = {
  write: { writes: ['path', 'file_path', 'filename', 'file', 'content_path'] },
  edit: { writes: ['path', 'file_path', 'filename', 'file', 'content_path'] },
  bash: { commands: ['command', 'cmd'] },
  pwsh: { commands: ['command', 'cmd'] },
}

/** Build the registry a plugin provides and capabilities declare into. */
export function createGovernanceRegistry(): GovernanceRegistry {
  const byTool = new Map<string, ToolAccess>()
  const declaredOrder: string[] = []
  let grants: ReadonlyMap<string, readonly string[]> = new Map()

  return {
    declareTool(name, access) {
      if (!byTool.has(name)) declaredOrder.push(name)
      byTool.set(name, access)
      return () => {
        // Only the declaration that is still in place may withdraw itself: a later declaration for
        // the same name owns it now, and an earlier disposer must not take it away.
        if (byTool.get(name) !== access) return
        byTool.delete(name)
        declaredOrder.splice(declaredOrder.indexOf(name), 1)
      }
    },

    setGrants(next) {
      grants = next
    },

    govern(tool) {
      const declared = byTool.get(tool)
      const builtIn = BUILT_IN_ACCESS[tool]
      const access = declared ?? builtIn
      if (access === undefined) return undefined
      const grantedTo = grants.get(tool)
      // A code-running tool is judged program by program, so the grants for those programs are
      // gathered here — under the names the tool declared — rather than left for the guard to
      // guess at. A program with no entry is kept absent rather than emptied: the guard reads
      // "nobody granted" and "nothing said" differently, and refuses on the second with an entry
      // missing rather than a role missing.
      const programGrants: Record<string, readonly string[]> = {}
      for (const program of access.executes ?? []) {
        const roles = grants.get(program)
        if (roles !== undefined) programGrants[program] = roles
      }
      return {
        access,
        ...(Object.keys(programGrants).length === 0 ? {} : { programGrants }),
        ...(grantedTo === undefined ? {} : { grantedTo }),
        source: declared === undefined ? 'built-in' : 'declared',
      }
    },

    declared() {
      return [...declaredOrder]
    },
  }
}
