#!/usr/bin/env node
/**
 * Show what a domain derives, with no runtime and no API key.
 *
 * The claim this project makes is "declare a world, get an agent's powers" — and the
 * cheapest way to believe a claim like that is to watch it happen. The plugin needs a
 * host; the engine does not, so this skips the host and prints what a domain produced.
 *
 *   node packages/ontology/scripts/show-derivation.ts packages/ontology/examples/project-delivery
 *   node packages/ontology/scripts/show-derivation.ts packages/ontology/tests/fixtures/review-delivery \
 *     --roles '[{"prefix":"session-","role":"engineer"}]'
 *
 * Nothing here is a mock: every line comes from the same `domainSnapshot` the workspace
 * panel reads, via the same function the README image is generated from.
 */
import type { RoleRule } from '../src/govern/permission.ts'
import { derivationLines } from './derivation-lines.ts'

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

process.stdout.write(`${derivationLines(root, roles).join('\n')}\n`)
