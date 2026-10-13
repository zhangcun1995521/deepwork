/**
 * The lines `show-derivation` prints, as a value rather than a side effect.
 *
 * Split out so the CLI and the README image render the same thing. An image generated
 * from the same function as the terminal output cannot drift from it — which is the
 * difference between documentation and decoration.
 *
 * @module @zhangcun123/ontology/scripts/derivation-lines
 */
import { resolve } from 'node:path'

import { loadGraph } from '../src/engine/graph.ts'
import type { RoleRule } from '../src/govern/permission.ts'
import { domainSnapshot } from '../src/web.ts'

/** What a domain derives, as printable lines. */
export function derivationLines(root: string, roles: RoleRule[] = []): string[] {
  const graph = loadGraph(resolve(root))
  const snapshot = domainSnapshot(graph, roles)
  const lines: string[] = []

  lines.push(`domain   ${snapshot.root}`)
  lines.push(
    `         ${snapshot.summary.objectTypes} object types, ${snapshot.summary.objects} instances, ` +
      `${snapshot.summary.linkTypes} relations (${snapshot.summary.links} edges)`,
  )

  lines.push('')
  lines.push(`tools    ${snapshot.summary.readTools} read, ${snapshot.summary.writeTools} write`)
  for (const tool of snapshot.tools.read) lines.push(`         ${tool.name}`)
  for (const tool of snapshot.tools.write) {
    lines.push(`         ${tool.name}   (registered because roles are configured)`)
  }
  if (snapshot.summary.writeTools === 0) {
    lines.push('         no write tool — with no roles configured, the deployment is read-only')
  }

  const actions = snapshot.actions
  const declared = snapshot.summary.declaredActions
  if (declared > 0) {
    const readOnly = snapshot.roles.length === 0
    lines.push('')
    lines.push(
      `actions  ${actions.length} derived of ${declared} declared` +
        (readOnly ? '   (no roles configured: read-only, so none is derived)' : ''),
    )
    for (const action of actions) {
      lines.push(
        `         ${action.name.padEnd(22)} ${action.use.padEnd(7)} ${action.target.padEnd(12)} ` +
          `by: ${action.by.length === 0 ? '(nobody)' : action.by.join(', ')}`,
      )
    }
    if (actions.length < declared && !readOnly) {
      lines.push('         some declared actions did not derive a tool — see the warnings')
    }
  }

  lines.push('')
  lines.push('objects')
  for (const type of snapshot.objectTypes) {
    lines.push(
      `         ${type.name.padEnd(12)} key=${type.primaryKey.padEnd(14)} ` +
        `instances=${String(type.instances).padEnd(3)} ` +
        `may write: ${type.writtenBy.length === 0 ? '(nobody)' : type.writtenBy.join(', ')}`,
    )
    if (type.lifecycle !== undefined) {
      lines.push(
        `         ${' '.repeat(12)} states: ${type.lifecycle.states.join(' → ')}` +
          (type.lifecycle.defaultState === undefined
            ? ''
            : `   (reads default to "${type.lifecycle.defaultState}")`),
      )
      for (const transition of type.lifecycle.transitions) {
        lines.push(
          `         ${' '.repeat(12)} ${transition.name}: ` +
            `${transition.from.join('/')} → ${transition.to}   by: ${transition.by.join(', ')}` +
            (transition.requiresReview ? '   requires an independent verdict' : ''),
        )
      }
    }
  }

  const warnings = [...snapshot.warnings.load, ...snapshot.warnings.derivation]
  if (warnings.length > 0) {
    lines.push('')
    lines.push('warnings')
    for (const warning of warnings) lines.push(`         ${warning}`)
  }

  // Kept apart from the warnings and always shown. A domain being written ahead of its data is
  // the normal state of a domain, but "nothing to fix" must not become "nothing to see" — nine
  // relations producing no edges is exactly what a reader wants to know.
  if (snapshot.notes.length > 0) {
    lines.push('')
    lines.push(`notes    ${snapshot.notes.length === 1 ? 'one thing' : `${snapshot.notes.length} things`} the data has not grown into; nothing to fix`)
    for (const note of snapshot.notes) lines.push(`         ${note}`)
  }

  return lines
}
