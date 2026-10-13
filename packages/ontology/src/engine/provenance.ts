/**
 * Who produced each object, recorded by the platform rather than declared by the caller.
 *
 * This exists because "the reviewer must not be the author" cannot be enforced against a
 * field the model fills in. A verdict object that names its own producer is a form, not a
 * control: the cheap path is to claim independence. So the write path records who wrote
 * what, in a file the domain does not own and the model never sees.
 *
 * It is a sidecar next to the domain rather than a field on the instance, for the same
 * reason the audit trail is: domain data should stay the domain's, and provenance is the
 * platform's business.
 *
 * @module @zhangcun123/ontology/engine/provenance
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The sidecar's conventional name, beside the domain. */
export const PROVENANCE_FILE = '.provenance.jsonl'

/** One recorded write. */
export interface ProvenanceEntry {
  /** When the write was allowed, ISO-8601. */
  at: string
  /** Object type written. */
  type: string
  /** Instance id written. */
  id: string
  /** Agent that made the write, when the runtime reported one. */
  agentId?: string
}

/** Append one entry, creating the file's directory if needed. */
export function appendProvenance(path: string, entry: ProvenanceEntry): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(entry)}\n`)
}

/**
 * Read the producer of every object, and how much of the file could not be read.
 *
 * The unreadable count is not diagnostics. It is the difference between "nobody
 * independent reviewed this" and "the record of who reviewed this is damaged", and a
 * control that treats those the same is a control that can be defeated by truncating a
 * file. Callers are expected to fail closed on it.
 *
 * The last write wins: re-writing an object makes the most recent author its producer,
 * which is the honest answer to "who vouches for this now".
 */
export function readProvenance(path: string): {
  producers: Map<string, string | undefined>
  unreadable: number
} {
  const producers = new Map<string, string | undefined>()
  let unreadable = 0

  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { producers, unreadable }
  }

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<ProvenanceEntry>
      if (typeof parsed.type !== 'string' || typeof parsed.id !== 'string') {
        unreadable += 1
        continue
      }
      producers.set(
        `${parsed.type}:${parsed.id}`,
        typeof parsed.agentId === 'string' ? parsed.agentId : undefined,
      )
    } catch {
      unreadable += 1
    }
  }
  return { producers, unreadable }
}
