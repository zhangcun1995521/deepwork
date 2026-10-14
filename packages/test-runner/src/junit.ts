/**
 * Reading what a test run said.
 *
 * junit separates two outcomes, and the line is **whether the test ever ran**: `<failure>` is a
 * test that ran and came out wrong, `<error>` is one that never got started because a fixture or
 * the collection above it blew up. That is not the distinction it is often described as — a
 * `RuntimeError` raised inside a test body is a `<failure>`, because pytest treats "the test ran
 * and raised" as the test failing. Verified by running both cases rather than by reading.
 *
 * Which leaves the distinction a reader actually wants — **an assertion disagreed** versus **an
 * exception escaped** — absent from the report's structure. It is not absent from the text:
 * pytest writes the exception's name at the front of the message, so `AssertionError` and
 * everything else can be told apart, and `kind` records which it was. That matters because the
 * two send a reader to different files: a wrong answer is the product's, an unhandled network
 * error is the test's.
 *
 * No XML library. junit is machine-written and its structure is fixed, so a parser for that
 * structure is smaller than a dependency and can be read in one sitting. What it must not do is
 * read the document as one string and look for substrings: a failure message containing the
 * literal text "<error" is exactly the sort of thing a test asserts about, and a substring search
 * would call that an error. Every scan below is bounded by the element it belongs to.
 *
 * @module @zhangcun123/test-runner/junit
 */

/** What a single case did. `failed` ran and disagreed; `error` never got to run. */
export type CaseStatus = 'passed' | 'failed' | 'error' | 'skipped'

/**
 * For a failing case, what kind of wrong it was.
 *
 * `assertion` is a test that checked something and found it false. `exception` is one that fell
 * over before it could check anything — the case worth looking at first, because it usually means
 * the test never exercised what it meant to.
 */
/**
 * The kinds a failure can be, as one list.
 *
 * An array rather than a bare type union because the manual has to document exactly these, and a
 * list the test can read is what keeps documentation from drifting away from behaviour. Adding a
 * kind here and forgetting the manual fails a test instead of shipping a manual that is quietly
 * incomplete.
 */
export const FAILURE_KINDS = ['assertion', 'exception', 'other'] as const

export type FailureKind = (typeof FAILURE_KINDS)[number]

/** One test, as the report recorded it. */
export interface JunitCase {
  /** The test's name, as the runner wrote it. */
  name: string
  /** The suite it belongs to, when the report says. */
  classname?: string
  /** A `TC-…` identifier pulled out of the name, when one is in there. */
  tcId?: string
  status: CaseStatus
  /** For a failing case: an assertion disagreed, or something threw before it could. */
  kind?: FailureKind
  /** Seconds, when the report timed it. */
  seconds?: number
  /** Where it went wrong: the first line of the failure or error text. */
  detail?: string
}

/** A whole run, counted. */
export interface JunitSummary {
  total: number
  passed: number
  failed: number
  error: number
  skipped: number
  cases: JunitCase[]
}

/** Attribute values in a start tag, entity-decoded. */
function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) found[name] = decode(value)
  }
  return found
}

/**
 * The entities a junit writer emits: the five named ones, and numeric references.
 *
 * The numeric ones matter more than they look. pytest puts the whole failure into a `message`
 * attribute with its newlines written as `&#10;`, so a reader that only knows `&amp;` hands back a
 * single unreadable line where a message with structure was intended.
 *
 * `&amp;` is decoded last, so that an escaped `&amp;#10;` — text that merely looks like a reference —
 * survives as text rather than becoming a newline.
 */
function decode(text: string): string {
  const codepoint = (raw: string, radix: number): string => {
    const code = Number.parseInt(raw, radix)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '?'
    try {
      return String.fromCodePoint(code)
    } catch {
      return '?'
    }
  }
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => codepoint(hex, 16))
    .replace(/&#(\d+);/g, (_match, dec: string) => codepoint(dec, 10))
    .replaceAll('&amp;', '&')
}

/** A `TC-…` id inside a test name, when the name carries one. */
function tcIdOf(name: string): string | undefined {
  // Not `\b`: a test named `test_order_TC-SAMPLE-001_rejects` has an underscore in front of the id,
  // and an underscore is a word character, so a word boundary would not be there. What separates
  // an id from the text around it is a character that is not part of one.
  const match = name.match(/(?:^|[^A-Za-z0-9])(TC-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/)
  return match?.[1]
}

/** The first non-empty line of a message, cut to something a report can hold. */
function firstLine(text: string, limit = 200): string | undefined {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return undefined
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/**
 * Whether a failure was an assertion or something thrown.
 *
 * junit does not say, so this reads the text. pytest puts the exception's name at the front of the
 * message, which is enough: `AssertionError` is a test that disagreed, anything else is a test
 * that fell over. `pytest.fail("…")` writes the reason alone, with no exception name, and is
 * reported as neither rather than guessed at.
 */
function failureKind(message: string): FailureKind {
  if (/^AssertionError\b/.test(message)) return 'assertion'
  if (/^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Failure)\b/.test(message)) {
    return 'exception'
  }
  return 'other'
}

/**
 * Parse a junit report.
 *
 * @param xml - The document, as the runner wrote it.
 * @returns every case, and the counts.
 */
export function parseJunit(xml: string): JunitSummary {
  const cases: JunitCase[] = []

  // Split on the start of each case, then keep only the part before the case ends. A case ends at
  // `</testcase>`, or at the `>` of its own start tag when that tag closes itself — and the
  // search for the outcome must stay inside that span, never wander into the next case.
  const parts = xml.split('<testcase')
  for (let index = 1; index < parts.length; index += 1) {
    const chunk = parts[index] ?? ''

    const openEnd = chunk.indexOf('>')
    if (openEnd === -1) continue
    const openTag = chunk.slice(0, openEnd)
    const selfClosed = openTag.trimEnd().endsWith('/')

    let body = ''
    if (!selfClosed) {
      const closeAt = chunk.indexOf('</testcase>')
      // No closing tag means a truncated document; take what there is rather than nothing.
      body = closeAt === -1 ? chunk.slice(openEnd + 1) : chunk.slice(openEnd + 1, closeAt)
    }

    const attrs = attributes(openTag)
    const name = attrs['name'] ?? '(unnamed)'

    let status: CaseStatus = 'passed'
    let detail: string | undefined
    let kind: FailureKind | undefined
    // Outcome elements are searched inside the case's own span. `<failure` and `<error` cannot
    // both be a case's outcome, and the first one found is the one to report.
    const outcome = body.match(/<(failure|error|skipped)([^>]*)>([\s\S]*?)<\/\1>/)
    if (outcome !== null) {
      const element = outcome[1]
      status = element === 'failure' ? 'failed' : element === 'error' ? 'error' : 'skipped'
      // pytest puts the exception's repr in the `message` attribute, and the body carries the
      // source line it happened on. The message is what a reader triaging wants; the source line
      // is what they open the file to see anyway.
      const message = attributes(outcome[2] ?? '')['message']
      detail = firstLine(message ?? '') ?? firstLine(decode(outcome[3] ?? ''))
      if (status === 'failed') {
        kind = failureKind(message ?? decode(outcome[3] ?? ''))
      }
    } else if (body.includes('<skipped')) {
      // A writer may self-close it: `<skipped/>`, with no text to capture.
      status = 'skipped'
    }

    const seconds = attrs['time'] === undefined ? undefined : Number(attrs['time'])
    const tcId = tcIdOf(name)
    cases.push({
      name,
      ...(attrs['classname'] === undefined ? {} : { classname: attrs['classname'] }),
      ...(tcId === undefined ? {} : { tcId }),
      status,
      ...(kind === undefined ? {} : { kind }),
      ...(seconds === undefined || Number.isNaN(seconds) ? {} : { seconds }),
      ...(detail === undefined ? {} : { detail }),
    })
  }

  return {
    total: cases.length,
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed').length,
    error: cases.filter((entry) => entry.status === 'error').length,
    skipped: cases.filter((entry) => entry.status === 'skipped').length,
    cases,
  }
}

/**
 * The cases worth reading, most useful first.
 *
 * Order is the point of the `kind` distinction. A case that never ran, then a case that fell over
 * before it asserted anything, then an assertion that disagreed, then skips. A reader who stops
 * after two lines should have seen the two that matter most.
 */
export function triage(summary: JunitSummary): JunitCase[] {
  const rank = (entry: JunitCase): number => {
    if (entry.status === 'error') return 0
    if (entry.status === 'failed') return entry.kind === 'exception' ? 1 : 2
    if (entry.status === 'skipped') return 3
    return 4
  }
  return summary.cases.filter((entry) => entry.status !== 'passed').sort((a, b) => rank(a) - rank(b))
}
