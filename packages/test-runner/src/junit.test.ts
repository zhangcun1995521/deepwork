/**
 * Tests for reading a junit report.
 *
 * The XML below is trimmed from a real pytest run rather than written by hand, because the things
 * worth pinning are the things a real writer does: a body exception reported as `<failure>`, a
 * fixture error reported as `<error>`, a message with its newlines escaped as `&#10;`, and a
 * self-closed case for a test that passed. Two of the fixes in this file came from reading that
 * output instead of the code.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseJunit, triage } from './junit.ts'

/** A suite with one of each outcome, as pytest wrote it. */
const REAL = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="0.13"><testcase classname="test_demo" name="test_passes" time="0.001" /><testcase classname="test_demo" name="test_fails" time="0.001"><failure message="AssertionError: deliberate assertion failure&#10;assert (2 + 2) == 5">def test_fails(): &gt;       assert 2 + 2 == 5</failure></testcase><testcase classname="test_demo" name="test_errors" time="0.000"><failure message="RuntimeError: deliberate unexpected exception">def test_errors(): &gt;       raise RuntimeError("x")</failure></testcase><testcase classname="test_fixture" name="test_needs_fixture" time="0.001"><error message="failed on setup with &quot;ConnectionError: unreachable&quot;">broken fixture</error></testcase><testcase classname="test_demo" name="test_skipped" time="0.000"><skipped type="pytest.skip" message="deliberately skipped">test_demo.py:16: deliberately skipped</skipped></testcase></testsuite></testsuites>`

test('a real run reads as four outcomes, not as pass or fail', () => {
  const summary = parseJunit(REAL)

  // Five cases, not the `tests="4"` the suite element claims: the count comes from the cases,
  // because an attribute that disagrees with its own contents is the attribute that is wrong.
  assert.equal(summary.total, 5)
  assert.equal(summary.passed, 1)
  assert.equal(summary.failed, 2)
  assert.equal(summary.error, 1)
  assert.equal(summary.skipped, 1)
})

test('junit says whether a test ran, and the text says what kind of wrong it was', () => {
  const summary = parseJunit(REAL)
  const byName = (name: string) => summary.cases.find((entry) => entry.name === name)

  // A body exception is a `<failure>` to junit — pytest treats "the test ran and raised" as the
  // test failing. The distinction a reader wants is in the message, not in the element.
  assert.equal(byName('test_errors')?.status, 'failed')
  assert.equal(byName('test_errors')?.kind, 'exception')
  assert.equal(byName('test_fails')?.status, 'failed')
  assert.equal(byName('test_fails')?.kind, 'assertion')

  // A fixture that blew up is an `<error>`: the test never ran.
  assert.equal(byName('test_needs_fixture')?.status, 'error')
  assert.equal(byName('test_passes')?.status, 'passed')
  assert.equal(byName('test_skipped')?.status, 'skipped')
})

test('a message keeps its shape, because a writer escaped the newlines', () => {
  const summary = parseJunit(REAL)
  const failing = summary.cases.find((entry) => entry.name === 'test_fails')

  // `&#10;` decoded, then cut at the first line: the assertion's own words, not a run-on line
  // carrying the source that follows it.
  assert.equal(failing?.detail, 'AssertionError: deliberate assertion failure')
})

test('what triage puts first is what a reader should read first', () => {
  const order = triage(parseJunit(REAL)).map((entry) => entry.name)

  assert.deepEqual(order, [
    'test_needs_fixture', // never ran
    'test_errors', // ran and fell over before asserting
    'test_fails', // ran and disagreed
    'test_skipped',
  ])
})

test('an escaped reference is text, not a reference', () => {
  // `&amp;#10;` is a message about the string "&#10;", and must survive as written.
  const xml =
    '<testsuites><testcase name="test_x"><failure message="AssertionError: saw &amp;#10; literally">x</failure></testcase></testsuites>'
  assert.equal(parseJunit(xml).cases[0]?.detail, 'AssertionError: saw &#10; literally')
})

test('a case whose message mentions <error> is still a failure', () => {
  // The reason this parser bounds every scan to its element: a test that asserts about the text
  // "<error" writes it into the message, and a substring search would call that case an error.
  const xml =
    '<testsuites><testcase name="test_about_errors"><failure message="AssertionError">assert &quot;&lt;error&gt;&quot; in output</failure></testcase></testsuites>'
  const summary = parseJunit(xml)

  assert.equal(summary.failed, 1)
  assert.equal(summary.error, 0)
  assert.equal(summary.cases[0]?.kind, 'assertion')
})

test('a case identifier is read out of the name when one is in there', () => {
  const xml =
    '<testsuites><testcase name="test_order_TC-SAMPLE-001_rejects" time="0.5" /><testcase name="test_plain" /></testsuites>'
  const summary = parseJunit(xml)

  assert.equal(summary.cases[0]?.tcId, 'TC-SAMPLE-001')
  assert.equal(summary.cases[0]?.seconds, 0.5)
  assert.equal(summary.cases[1]?.tcId, undefined)
})

test('a report with no cases is four zeros rather than a failure', () => {
  const summary = parseJunit('<testsuites></testsuites>')
  assert.deepEqual(
    { ...summary, cases: [] },
    { total: 0, passed: 0, failed: 0, error: 0, skipped: 0, cases: [] },
  )
})
