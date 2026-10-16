/**
 * The reach trail.
 *
 * One line per call — the refusals and the runs alike — because the question asked after an incident
 * is not what succeeded. It is who tried, what they aimed at, and which refusals were fired in the
 * days before somebody stopped asking.
 *
 * **What a line never contains.** Not the credential, which is the obvious one. Not the program's
 * output, which is the write trail's own rule: field names are recorded and field values are not,
 * because a trail that copies content doubles the surface that content leaks from. And not the
 * address, which is the one that is easy to miss — an address may carry a token in its query string,
 * and a log is not the place to find that out. The route id is the pointer; the domain behind it is
 * still readable by whoever is entitled to read it.
 *
 * **A record shape of this package's own.** The ontology's `AuditEntry` describes a write to a
 * declared object — a type, an id, a file, the names of the fields written — and has no room for a
 * program, an exit status or whether the far side answered. Squeezing those into its `detail` string
 * would make the trail unqueryable, which is the half of a trail that matters. What is shared is the
 * file handling, through the ontology's `appendAuditLine`, so both trails land in the same format in
 * the same place while neither package owns the other's vocabulary. `kind` is what tells them apart,
 * the same device the guard's own entries use.
 *
 * **When the line is written.** A refusal is recorded before it is returned, which is free and is
 * the path an investigation actually replays. A call that ran is recorded once its outcome is known,
 * because the exit status and the elapsed time are what the line is for. A call whose line cannot be
 * written throws rather than returning a success: the far side may well have been reached, and a
 * caller told the call worked while nothing was recorded has no way of finding that out later.
 *
 * @module @zhangcun123/external/audit
 */

import { appendAuditLine } from '@zhangcun123/ontology/govern/audit'

/** One recorded attempt to reach a system. */
export interface ReachAuditEntry {
  /** When the attempt happened, ISO-8601. */
  at: string
  /** Always `reach`; the event kind, so a reader can tell these from write and guard entries. */
  kind: 'reach'
  /** Route id the call named. */
  route: string
  /** Program the deployment's command started. */
  program: string
  /** Whether the call was allowed to happen — not whether the far side answered. */
  outcome: 'allowed' | 'denied'
  /** Exit status of the program, when it ran and had one. */
  exitCode?: number | null
  /** True when the program exited 0. Present only on a call that ran. */
  reachable?: boolean
  /** True when the deadline was reached and the program was killed. */
  timedOut?: boolean
  /** How long the program ran, in milliseconds. */
  elapsedMs?: number
  /** Machine-readable refusal reason, when denied. */
  reason?: string
  /** Human-readable refusal, when denied. */
  detail?: string
}

/**
 * Render one entry as a JSON line.
 *
 * Separated from appending for the reason the ontology module gives for the same split: the shape of
 * a record is then testable without touching a disk.
 */
export function formatReachLine(entry: ReachAuditEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/**
 * Append one rendered line to the trail, creating its directory if needed.
 *
 * @param path - Absolute path of the audit log.
 * @param entry - The attempt to record.
 */
export function recordReach(path: string, entry: ReachAuditEntry): void {
  appendAuditLine(path, formatReachLine(entry))
}
