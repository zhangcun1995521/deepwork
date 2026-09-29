/**
 * The write trail.
 *
 * Every write attempt is recorded — allowed or denied, with the caller, the role it
 * acted under, the target, and the reason when it failed. A governance layer that only
 * logs its successes cannot answer the question anyone actually asks after an incident,
 * which is who tried and was refused.
 *
 * Formatting is separated from appending so the shape of a record is testable without
 * touching a disk.
 *
 * @module @zhangcun123/ontology/govern/audit
 */

import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One recorded write attempt. */
export interface AuditEntry {
  /** When the attempt happened, ISO-8601. */
  at: string
  /** Which tool was called, e.g. `ontology_write`. */
  action: string
  /** Identity the runtime reported, when it reported one. */
  agentId?: string
  /** Role the caller was resolved to, when one was resolved. */
  role?: string
  /** Declared type the write targeted. */
  type: string
  /** Instance id the write targeted. */
  id: string
  /** Path the write would touch. */
  file: string
  /** Whether it proceeded. */
  outcome: 'allowed' | 'denied'
  /** Machine-readable refusal reason, when denied. */
  reason?: string
  /** Human-readable refusal detail, when denied. */
  detail?: string
  /** Names of the fields written, when allowed. Never their values. */
  fields?: string[]
}

/**
 * Render one entry as a JSON line.
 *
 * Field *names* are recorded and field *values* are not. An audit trail that copies
 * domain content into a second file doubles the surface that content leaks from,
 * which is the opposite of what an audit trail is for.
 */
export function formatAuditLine(entry: AuditEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/**
 * Append one rendered line to the audit log, creating its directory if needed.
 *
 * @param path - Absolute path of the audit log.
 * @param line - A line produced by `formatAuditLine`.
 */
export function appendAuditLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, line)
}
