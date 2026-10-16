/**
 * The scripts, run for real.
 *
 * Every other test here is about mounting; this file is the only place the machine is actually
 * touched, and that is deliberate — the failures this capability can have are the ones that only
 * appear when `powershell.exe` runs: an argument mangled on the way in, a reply written in the wrong
 * encoding, a `SendInput` that reports success and types nothing. None of those is visible to a test
 * that stops at the registry.
 *
 * Only the refusals are exercised, and only refusals that change nothing: a bogus handle, a window
 * the deployment did not name, an index whose element has moved. A test suite that clicked a real
 * button would be a test suite nobody could run twice.
 *
 * Windows-only, like the capability. On anything else these are skipped rather than failed, because
 * the absence of a desktop is not a defect in the code that reaches one.
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runScript } from './ps.ts'

const ONLY_WINDOWS = { skip: process.platform !== 'win32' ? 'Windows-only capability' : false }

/** A window that exists right now, or undefined on a machine with no addressable window. */
async function anyWindow(): Promise<{ handle: number; title: string } | undefined> {
  const outcome = await runScript('list-windows.ps1')
  const windows = (outcome.json?.['windows'] ?? []) as { handle?: number; title?: string }[]
  const found = windows.find((w) => typeof w.handle === 'number' && (w.title ?? '').length > 0)
  if (found === undefined) return undefined
  return { handle: found.handle as number, title: found.title ?? '' }
}

test('list-windows reports the screen and the windows on it', ONLY_WINDOWS, async () => {
  const outcome = await runScript('list-windows.ps1')

  assert.equal(outcome.exitCode, 0, outcome.missing ?? stderrText(outcome.stderr))
  assert.ok(outcome.json !== undefined, outcome.missing)
  const json = outcome.json as { screen?: { width?: number }; windows?: unknown[] }
  assert.ok((json.screen?.width ?? 0) > 0, 'a desktop has a width')
  assert.ok(Array.isArray(json.windows))
})

test('a handle that names no window is refused, and the refusal is readable', ONLY_WINDOWS, async () => {
  // The one refusal reachable with no window at all: the guard for a caller that has nothing to aim
  // at. It is also the proof that an exception in PowerShell does not become an unreadable crash —
  // the reply is written, on the path, as JSON.
  const outcome = await runScript('invoke.ps1', ['click', 999_999_999, 3], {})

  assert.equal(outcome.json?.['ok'], false)
  assert.equal(outcome.json?.['refused'], 'window-gone')
})

test('a window the deployment did not name is refused before anything is touched', ONLY_WINDOWS, async () => {
  const window = await anyWindow()
  if (window === undefined) return
  const outcome = await runScript(
    'invoke.ps1',
    ['screenshot', window.handle, -1],
    { applications: ['A window title that does not exist anywhere'] },
  )

  assert.equal(outcome.json?.['ok'], false)
  assert.equal(outcome.json?.['refused'], 'app-not-allowed')
})

test('an index whose element has moved is refused rather than acted on', ONLY_WINDOWS, async () => {
  // Index 0 of any real window is not a button with this name, so the check must refuse. This is the
  // guard that stands between a stale index and a click on whatever is there now.
  const window = await anyWindow()
  if (window === undefined) return
  const outcome = await runScript(
    'invoke.ps1',
    ['click', window.handle, 0],
    { expect: { control: 'Button', name: 'a name no addressable element has' } },
  )

  assert.equal(outcome.json?.['ok'], false)
  assert.equal(outcome.json?.['refused'], 'index-moved')
  // The refusal carries both sides, or a caller cannot tell a moved index from a misspelling.
  assert.ok(outcome.json?.['expected'] !== undefined)
  assert.ok(outcome.json?.['actual'] !== undefined)
})

test('reading a window returns elements with indices a caller can address', ONLY_WINDOWS, async () => {
  const window = await anyWindow()
  if (window === undefined) return
  const outcome = await runScript('get-window-state.ps1', [window.handle, 200])

  assert.equal(outcome.exitCode, 0, outcome.missing ?? stderrText(outcome.stderr))
  const json = outcome.json as { elements?: { index?: number }[] }
  assert.ok(Array.isArray(json.elements))
  for (const [i, e] of (json.elements ?? []).entries()) {
    assert.equal(e.index, i, 'indices are the position in the walk')
  }
})

test('a capture narrowed to an index is the element, not the window it sits in', ONLY_WINDOWS, async () => {
  // The bug this pins was silent: the tool advertised an `index` and the script captured the whole
  // window anyway. Nothing failed, the picture was just wrong — a disagreement between what a tool
  // says and what it does, which is the class of failure this repository keeps having to name.
  const window = await anyWindow()
  if (window === undefined) return
  const state = await runScript('get-window-state.ps1', [window.handle, 200])
  const elements = (state.json?.['elements'] ?? []) as { index?: number; width?: number; height?: number }[]
  // A real element with an area to copy, and one that does not fill its window — otherwise the two
  // captures are the same size and the test would pass without distinguishing them.
  const windowArea = await windowBox(window.handle)
  const target = elements.find(
    (e) => (e.width ?? 0) > 0 && (e.height ?? 0) > 0 && ((e.width ?? 0) < windowArea.width || (e.height ?? 0) < windowArea.height),
  )
  if (target === undefined) return

  const imagePath = join(tmpdir(), `deepwork-computer-test-${Date.now()}.png`)
  const outcome = await runScript('invoke.ps1', ['screenshot', window.handle, target.index ?? 0], { imagePath })
  const did = String(outcome.json?.['did'] ?? '')

  assert.equal(outcome.json?.['ok'], true, did)
  assert.match(
    did,
    new RegExp(`captured ${target.width} x ${target.height} `),
    `a capture named an index and must be that element's box (${target.width}x${target.height}), not the window's`,
  )
})

/** A window's own box, from the list, so a test can tell an element from the window around it. */
async function windowBox(handle: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const outcome = await runScript('list-windows.ps1')
  const windows = (outcome.json?.['windows'] ?? []) as {
    handle?: number
    x?: number
    y?: number
    width?: number
    height?: number
  }[]
  const found = windows.find((w) => w.handle === handle)
  return { x: found?.x ?? 0, y: found?.y ?? 0, width: found?.width ?? 0, height: found?.height ?? 0 }
}

test('a point outside the named window is refused rather than clicked', ONLY_WINDOWS, async () => {
  // The only guard the blind verb has. A coordinate a caller meant for one window must not land on
  // whatever has since moved over it, and a window's own corner is the one edge this can check
  // without naming an element. Ten pixels above and left of that corner is outside it — and for a
  // window at the origin, negative, which is outside too.
  const window = await anyWindow()
  if (window === undefined) return
  const box = await windowBox(window.handle)
  const outcome = await runScript('invoke.ps1', ['click_at', window.handle, -1], {
    x: box.x - 10,
    y: box.y - 10,
  })

  assert.equal(outcome.json?.['ok'], false, 'a point outside the window must not be clicked')
  assert.equal(outcome.json?.['refused'], 'point-outside-window')
})

/** The stderr, bounded, so a failing assertion prints a message and not a wall. */
function stderrText(stderr: string): string {
  return stderr.slice(0, 400)}
