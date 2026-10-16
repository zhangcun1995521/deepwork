/**
 * Running one PowerShell script, once, and reading what it wrote.
 *
 * Every script in `scripts/` follows the same contract, and this module is the one place that
 * contract is spoken: **arguments in as files, results out as a file.** Nothing crosses as a
 * command-line string or as stdout, and that is not tidiness — a window title, a typed string and a
 * file path all carry quotes, backslashes and Chinese, and each of those is rewritten somewhere on
 * the way through a shell or through PowerShell's own argument parser. The read scripts say it in
 * their own comments; this is the Node half of the same rule.
 *
 * The scripts themselves are not ours to run through a shell: they are spawned directly, with the
 * program name and an argument array, so nothing between here and `powershell.exe` gets a chance to
 * reinterpret an argument.
 *
 * @module @zhangcun123/computer/ps
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The interpreter every script runs under. Named, because the guard is told this exact name. */
export const POWERSHELL = 'powershell.exe'

/**
 * Where the scripts live, resolved from this module.
 *
 * `../src/scripts/` resolves to the package's `src/scripts` whether this file is the TypeScript
 * source being run directly by `node --test` or the compiled `lib/ps.js` being loaded from a
 * profile — `src` and `lib` are both one level under the package root, and the scripts ship beside
 * the source (see `files` in the manifest, which is why they are not under `lib`).
 */
export const SCRIPTS_DIR = fileURLToPath(new URL('../src/scripts/', import.meta.url))

/** What one script run produced. */
export interface Outcome {
  /** The exit status, or null when the process was killed before it had one. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The JSON the script wrote, when it wrote one this module could read. */
  json?: Record<string, unknown>
  /** Why there is no JSON, when there is not one — the field a caller reports instead of guessing. */
  missing?: string
}

/** Seconds a script is allowed before it is killed. A hung `SendInput` must not hang the agent. */
export const SCRIPT_TIMEOUT_SECONDS = 30

/**
 * Run one script and read the JSON it wrote.
 *
 * @param script - The file name inside `scripts/`, e.g. `list-windows.ps1`.
 * @param leading - The script's own arguments, after the output path this function supplies.
 * @param payload - Written to a file and passed as the last argument, for scripts that take one.
 */
export async function runScript(
  script: string,
  leading: readonly (string | number)[] = [],
  payload?: unknown,
): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-computer-'))
  const outPath = join(dir, 'out.json')
  try {
    const args = [join(SCRIPTS_DIR, script), outPath, ...leading.map(String)]
    if (payload !== undefined) {
      const payloadPath = join(dir, 'payload.json')
      writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')
      args.push(payloadPath)
    }

    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
      // `windowsHide` because a console would otherwise flash on every call from a GUI host — the
      // agent's own window doing the blinking, for a script nobody asked to see.
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      const deadline = setTimeout(() => {
        child.kill()
        resolve(null)
      }, SCRIPT_TIMEOUT_SECONDS * 1000)
      child.on('error', () => {
        clearTimeout(deadline)
        resolve(null)
      })
      child.on('close', (code) => {
        clearTimeout(deadline)
        resolve(code)
      })
    })

    const outcome: Outcome = { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }

    // A script that threw writes no file, and its message is on stderr. That is turned into
    // `missing` rather than surfaced as JSON, so a caller renders one shape whether the failure was
    // "the script said no" (JSON with `refused`) or "the script could not run" (this).
    let raw: string
    try {
      raw = readFileSync(outPath, 'utf8')
    } catch {
      outcome.missing =
        stderr.trim().length > 0
          ? stderr.trim()
          : `${script} wrote no result (exit ${exitCode ?? 'none'})`
      return outcome
    }

    try {
      outcome.json = JSON.parse(raw) as Record<string, unknown>
    } catch {
      outcome.missing = `${script} wrote a result that is not JSON`
    }
    return outcome
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
