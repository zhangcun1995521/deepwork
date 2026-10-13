#!/usr/bin/env node
/**
 * Check that a domain's declarations took effect, and say so with an exit code.
 *
 * `show-derivation` prints a domain for a human to read; this one is for a pipeline to judge.
 * The difference that matters is the exit status: a domain whose declaration was silently
 * dropped must fail here, because the alternative is that it succeeds everywhere else — the
 * panel renders, the agent starts, and one tool is simply missing.
 *
 *   node packages/ontology/scripts/validate-domain.ts <domain-directory> [<domain-directory> ...]
 *     [--role <prefix>=<role> ...]
 *
 * Roles are what make the write and action halves reachable, so a run without them checks
 * less. That is stated in the output rather than left implicit: a pass is a claim, and this
 * prints the claim it is actually entitled to make.
 *
 * A report has two levels, because the two answer different questions. **Problems** need
 * somebody to act — a declaration that cannot take effect, an instance file that cannot be read
 * — and they fail the run. **Notes** are facts about the data that need nobody to act: a declared
 * directory with nothing in it yet, a relation no instance has wired. Notes are counted and
 * printed and never fail, because a domain written ahead of its data is the normal state of a
 * domain, and a check that red-lights it is one people stop reading — which is how the real
 * problem is missed once it arrives. Real data settled that line: a domain that loaded and
 * answered correctly produced nine unwired relations and three empty directories.
 *
 * `--role` is `prefix=role` rather than the role map as JSON because this command is meant to
 * run from package scripts, and a JSON argument does not survive one: npm hands the script to
 * `cmd.exe` on Windows, which strips the double quotes JSON requires. Splitting on `=` needs
 * no quoting on any of the three shells this is expected to run under.
 */
import { resolve } from 'node:path'

import { loadGraph } from '../src/engine/graph.ts'
import type { RoleRule } from '../src/govern/permission.ts'
import { validateDomain, type DomainReport } from '../src/validate.ts'

const args = process.argv.slice(2)

// Walk rather than filter: a flag's value is not a domain, and `--role` takes one that does
// not itself start with `--`, which is exactly the shape a filter would mistake for a root.
const roots: string[] = []
const roles: RoleRule[] = []
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index] ?? ''
  if (argument === '--role') {
    const rule = args[index + 1] ?? ''
    index += 1
    const separator = rule.indexOf('=')
    if (separator === -1) {
      process.stderr.write(`--role expects <prefix>=<role>, got "${rule}"\n`)
      process.exit(2)
    }
    roles.push({ prefix: rule.slice(0, separator), role: rule.slice(separator + 1) })
    continue
  }
  if (argument.startsWith('--')) continue
  roots.push(argument)
}

if (roots.length === 0) {
  process.stderr.write(
    'usage: validate-domain.ts <domain-directory> [<domain-directory> ...] ' +
      '[--role <prefix>=<role>]\n',
  )
  process.exit(2)
}

/** Indent a message that may itself contain newlines, so the block stays one block. */
function indented(message: string, pad: string): string[] {
  return message.split('\n').map((line) => `${pad}${line}`)
}

function describe(root: string): { lines: string[]; problems: number; notes: number } {
  const lines: string[] = [`domain   ${root}`]
  let report: DomainReport

  try {
    report = validateDomain(loadGraph(resolve(root)), roles)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(...indented(`cannot load: ${message}`, '         '))
    return { lines, problems: 1, notes: 0 }
  }

  const { summary } = report
  lines.push(
    `         ${summary.objectTypes} object types, ${summary.objects} instances, ` +
      `${summary.linkTypes} relations (${summary.links} edges)`,
  )
  lines.push(
    `         tools ${summary.readTools} read, ${summary.writeTools} write; ` +
      `actions ${summary.derivedActions} derived of ${summary.declaredActions} declared`,
  )

  if (!report.writesChecked) {
    lines.push(
      '         write half not checked: no roles configured, so nothing derives there and ' +
        'declared cannot be compared against derived',
    )
  }

  if (report.diagnostics.length === 0) {
    lines.push('         clean')
  } else {
    lines.push(`         ${report.diagnostics.length} problems`)
    for (const diagnostic of report.diagnostics) {
      lines.push(...indented(`[${diagnostic.source}] ${diagnostic.message}`, '           '))
    }
  }

  // Reported, and not a failure. A domain written ahead of its data is the normal state of a
  // domain; what matters is that the count is visible, since "nothing to fix" must not hide
  // "nine relations produce no edges".
  if (report.notes.length > 0) {
    lines.push(`         ${report.notes.length} notes (nothing to fix)`)
    for (const note of report.notes) lines.push(...indented(note, '           '))
  }

  return { lines, problems: report.diagnostics.length, notes: report.notes.length }
}

const blocks: string[] = []
let failed = 0
let noted = 0
for (const root of roots) {
  const { lines, problems, notes } = describe(root)
  if (problems > 0) failed += 1
  if (notes > 0) noted += 1
  blocks.push(lines.join('\n'))
}

process.stdout.write(`${blocks.join('\n\n')}\n\n`)
process.stdout.write(
  `${roots.length} domain${roots.length === 1 ? '' : 's'} checked: ` +
    `${roots.length - failed} clean, ${failed} with problems` +
    (noted === 0 ? '' : `, ${noted} carrying notes`) +
    '\n',
)

process.exit(failed > 0 ? 1 : 0)
