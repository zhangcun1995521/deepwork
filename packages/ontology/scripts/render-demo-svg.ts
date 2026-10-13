#!/usr/bin/env node
/**
 * Render the derivation demo as an SVG, so the README leads with something you can look at.
 *
 * Generated, not drawn: it runs the same `derivationLines` the CLI prints, so the picture
 * cannot drift from the output. Re-run it whenever the output changes:
 *
 *   node packages/ontology/scripts/render-demo-svg.ts
 *
 * Colours follow one rule: a line that would be different under a different declaration is
 * highlighted, everything else stays quiet. The point of the image is the difference between
 * the two panels, so the eye should land on `0 write` becoming `1 write` and on the verdict
 * requirement — not on a rainbow.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { derivationLines } from './derivation-lines.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const OUT = resolve(REPO, 'docs/derivation.svg')

const PANELS = [
  {
    command: 'npm run demo',
    caption: 'no roles configured',
    lines: relativeRoot(derivationLines(resolve(REPO, 'packages/ontology/examples/project-delivery'))),
    // Only show the tool half: the object list is the same in both panels and the point is
    // what changed between them.
    keep: (line: string) => line === '' || /^domain|^ {9}|^tools/.test(line),
  },
  {
    command: "npm run demo -- --roles '[{\"prefix\":\"session-\",\"role\":\"delivery-lead\"}]'",
    caption: 'one role declared',
    lines: relativeRoot(
      derivationLines(resolve(REPO, 'packages/ontology/examples/project-delivery'), [
        { prefix: 'session-', role: 'delivery-lead' },
      ]),
    ),
    keep: (line: string) => line === '' || /^domain|^ {9}|^tools|^actions|^objects/.test(line),
  },
]

/**
 * The demo prints an absolute root because that is the honest answer on the terminal. In a
 * picture it is machine noise, and the path a reader cares about is the one in the repository.
 */
function relativeRoot(lines: string[]): string[] {
  return lines.map((line) =>
    line.startsWith('domain   ') ? `domain   packages/ontology/examples/project-delivery` : line,
  )
}

const FONT = 13
const LINE = 20
const PAD = 22
const CHROME = 34
const WIDTH = 880
const CHARS = 96

/** Escape the five characters that would otherwise end the text node or the document. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Colour by meaning. `write` counts and the review requirement are the two things a reader
 * should notice; everything else is deliberately the same grey.
 */
function colour(line: string): string {
  if (line.includes('no write tool')) return '#f0a53a'
  if (line.includes('(registered because roles are configured)')) return '#37c98f'
  if (/^\s*\d+ read, \d+ write/.test(line)) return '#e6e8eb'
  if (/^domain|^\s+\d+ object types/.test(line)) return '#9aa4b2'
  if (line.includes('requires an independent verdict')) return '#f0a53a'
  if (line.includes('states:')) return '#5b8cff'
  if (/^actions\s/.test(line)) return '#e6e8eb'
  if (line.includes('no roles configured: read-only')) return '#9aa4b2'
  return '#c8d3e0'
}

const blocks: string[] = []
let y = PAD + CHROME + 26

for (const panel of PANELS) {
  const prompt = `$ ${panel.command}`
  blocks.push(
    `<text x="${PAD}" y="${y}" xml:space="preserve" fill="#37c98f">${esc(prompt)}</text>`,
  )
  y += LINE
  blocks.push(
    `<text x="${PAD}" y="${y}" xml:space="preserve" fill="#6b7684"># ${esc(panel.caption)}</text>`,
  )
  y += LINE + 4

  for (const line of panel.lines) {
    if (!panel.keep(line)) continue
    if (line === '' && blocks[blocks.length - 1]?.includes('#6b7684') === false && false) continue
    if (line !== '') {
      blocks.push(
        `<text x="${PAD}" y="${y}" xml:space="preserve" fill="${colour(line)}">${esc(line.slice(0, CHARS))}</text>`,
      )
    }
    y += LINE
  }
  y += 16
}

const height = y + PAD - 10

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT}">
  <rect x="0" y="0" width="${WIDTH}" height="${height}" rx="12" fill="#0f1115"/>
  <rect x="0" y="0" width="${WIDTH}" height="${CHROME}" rx="12" fill="#161a21"/>
  <rect x="0" y="${CHROME - 12}" width="${WIDTH}" height="12" fill="#161a21"/>
  <circle cx="22" cy="${CHROME / 2}" r="6" fill="#ff6b6b"/>
  <circle cx="44" cy="${CHROME / 2}" r="6" fill="#f0a53a"/>
  <circle cx="66" cy="${CHROME / 2}" r="6" fill="#37c98f"/>
  <text x="${WIDTH / 2}" y="${CHROME / 2 + 5}" fill="#9aa4b2" text-anchor="middle" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif">DeepWork — the same domain, declared twice</text>
${blocks.join('\n')}
</svg>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, svg)
process.stdout.write(`wrote ${OUT} (${svg.length} bytes, ${PANELS.length} panels)\n`)
