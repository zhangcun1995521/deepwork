#!/usr/bin/env node
/**
 * Show what a domain derives, with no runtime and no API key.
 *
 * The claim this project makes is "declare a world, get an agent's powers" — and that claim
 * is easiest to believe when you can watch it happen in ten seconds. The plugin needs a
 * host; the engine does not, so this script skips the host entirely and prints what a
 * domain produced.
 *
 *   node packages/ontology/scripts/show-derivation.ts packages/ontology/examples/project-delivery
 *   node packages/ontology/scripts/show-derivation.ts packages/ontology/tests/fixtures/lifecycle \
 *     --roles '[{"prefix":"session-","role":"curator"}]'
 *
 * Nothing here is a mock: every line comes from the same `domainSnapshot` the workspace
 * panel reads.
 */
import { resolve } from 'node:path'

import type { RoleRule } from '../src/govern/permission.ts'
import { loadGraph } from '../src/engine/graph.ts'
import { domainSnapshot } from '../src/web.ts'

const args = process.argv.slice(2)
const root = args.find((argument) => !argument.startsWith('--'))
if (root === undefined) {
  process.stderr.write(
    'usage: show-derivation.ts <domain-directory> [--roles \'[{"prefix":"…","role":"…"}]\']\n',
  )
  process.exit(2)
}

const rolesFlag = args.indexOf('--roles')
const roles: RoleRule[] =
  rolesFlag === -1 ? [] : (JSON.parse(args[rolesFlag + 1] ?? '[]') as RoleRule[])

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
for (const tool of snapshot.tools.read) {
  lines.push(`         ${tool.name}`)
}
for (const tool of snapshot.tools.write) {
  lines.push(`         ${tool.name}   (registered because roles are configured)`)
}
if (snapshot.summary.writeTools === 0) {
  lines.push('         no write tool — with no roles configured, the deployment is read-only')
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

process.stdout.write(`${lines.join('\n')}\n`)
