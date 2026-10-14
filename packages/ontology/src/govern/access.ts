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
 *   - **what it touches** — argument names holding a path it writes, a path it runs what is in, or
 *     a command line. Declared by the tool, because only the tool knows its own arguments.
 *   - **who may call it** — declared by the domain, because only the deployment knows who is
 *     allowed. A tool that touches something outside the domain has no directory rule to be judged
 *     by; the grant is the whole of its authority, and a tool that declares itself and is granted
 *     to nobody is refused.
 *
 * The direction of failure matters. A tool that declares nothing is not governed — that is the
 * limit this cannot close from here, and it is stated rather than papered over. But a tool that
 * declares itself and finds no grant is **denied**, because "nobody said who may call this" is a
 * worse answer to give an execution tool than "no".
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
   * Argument names whose value is a path this tool runs whatever is inside.
   *
   * Kept apart from `writes` because the two are judged differently: a write is checked against the
   * directories the caller's role may write, while running code that sits outside the domain has no
   * such directory to be checked against and is authorised by the grant alone.
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
   * Roles granted this tool, when the domain declares any.
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
      return {
        access,
        ...(grantedTo === undefined ? {} : { grantedTo }),
        source: declared === undefined ? 'built-in' : 'declared',
      }
    },

    declared() {
      return [...declaredOrder]
    },
  }
}
