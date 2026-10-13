/**
 * Whether a domain's declarations actually took effect.
 *
 * The write path is fail-closed: an unconfigured role writes nothing rather than everything.
 * The declaration path was the opposite — a malformed declaration pushed a warning and was
 * skipped, so the author saw a domain that loaded cleanly and a capability that quietly was
 * not there. That is the failure mode this module exists to name, and it is the same defect
 * `action_types` had: a declaration that does not take effect is worse than no declaration,
 * because the author believes it worked.
 *
 * Everything reported here already carries a case-specific message written where the defect
 * was found. This module does not rewrite them; it collects them, adds the one check that no
 * warning covers, and leaves the decision to the caller.
 *
 * @module @zhangcun123/ontology/validate
 */

import type { OntologyGraph } from './engine/graph.ts'
import type { RoleRule } from './govern/permission.ts'
import { undeliveredActions } from './tools/actions.ts'
import { domainSnapshot, type DomainSnapshot } from './web.ts'

/** Where a problem was found, which is also what a reader needs to act on it. */
export interface Diagnostic {
  /** `load` read the schema and instances; `derivation` built the tools; `reconciliation`
   * compared the two and found a declaration that produced nothing. */
  source: 'load' | 'derivation' | 'reconciliation'
  message: string
}

/** What one domain declared, and everything that stopped it from taking effect. */
export interface DomainReport {
  root: string
  roles: readonly RoleRule[]
  summary: DomainSnapshot['summary']
  /** Problems that need somebody to act. A domain fails on these. */
  diagnostics: Diagnostic[]
  /**
   * Facts about the data that need nobody to act — see `OntologyGraph.notes`.
   *
   * Reported rather than dropped, and not counted as failure. A domain written ahead of its
   * data is the normal state of a domain, and a check that red-lights it is one people stop
   * reading; the count is what keeps "nothing to fix" from hiding "nine relations produce no
   * edges".
   */
  notes: string[]
  /**
   * Whether the write and action halves were derived at all.
   *
   * Without roles there is nothing to derive, so nothing in those halves is checked — not
   * because they are sound, but because the configuration makes them unreachable. Reported
   * rather than assumed, so a clean result is never read as a stronger claim than it is.
   */
  writesChecked: boolean
}

/**
 * Check one loaded domain.
 *
 * @param graph - A loaded domain. A schema file that cannot be read at all throws while
 *   loading, before this is reachable, and is the caller's to report.
 * @param roles - Role map for the write half. Empty leaves that half unchecked.
 */
export function validateDomain(
  graph: OntologyGraph,
  roles: readonly RoleRule[] = [],
): DomainReport {
  const snapshot = domainSnapshot(graph, roles)
  const diagnostics: Diagnostic[] = [
    ...snapshot.warnings.load.map((message): Diagnostic => ({ source: 'load', message })),
    ...snapshot.warnings.derivation.map(
      (message): Diagnostic => ({ source: 'derivation', message }),
    ),
  ]

  const writesChecked = roles.length > 0
  if (writesChecked) {
    for (const name of undeliveredActions(
      graph,
      snapshot.actions.map((action) => action.name),
    )) {
      diagnostics.push({
        source: 'reconciliation',
        message: `action "${name}" is declared but produced no tool`,
      })
    }
  }

  return {
    root: snapshot.root,
    roles,
    summary: snapshot.summary,
    diagnostics,
    notes: snapshot.notes,
    writesChecked,
  }
}
