/**
 * Running one command, once, with limits.
 *
 * A capability that executes is the strongest kind there is: it does not read the world, it changes
 * it. Three things follow, and all three are in here rather than in the caller.
 *
 * **The command is configuration.** Nothing a model said reaches this function. A tool that runs
 * what it is handed is a remote shell wearing a tool's name, and no amount of good intentions in a
 * prompt changes that.
 *
 * **Nothing runs forever.** A suite that hangs must not take the agent with it, so every run has a
 * deadline and the deadline kills the whole process tree — on Windows a shell keeps its children,
 * and killing the shell alone leaves pytest running with the port, the temp files, and the CPU.
 *
 * **Output is bounded.** A failing suite can print megabytes, and megabytes of it would crowd out
 * everything else in a context window. The cap is reported rather than applied quietly: a caller
 * reading a truncated failure has to know that the rest of it exists.
 *
 * @module @zhangcun123/test-runner/run
 */

import { spawn } from 'node:child_process'

/** What one run produced. */
export interface RunOutcome {
  command: string
  cwd: string
  /** The exit status, or null when the process was killed before it had one. */
  exitCode: number | null
  /** True when the deadline was reached and the tree was killed. */
  timedOut: boolean
  seconds: number
  stdout: string
  stderr: string
  /** True when either stream was cut. The text carried says how much is missing. */
  truncated: boolean
}

/** How much of a stream is kept before it is cut, in characters. */
export const STREAM_LIMIT = 20_000

/** Keep the head and the tail: a failure's first lines and its summary are both worth having. */
function bounded(text: string, limit = STREAM_LIMIT): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false }
  const half = Math.floor(limit / 2)
  return {
    text: `${text.slice(0, half)}\n… ${text.length - limit} characters omitted …\n${text.slice(-half)}`,
    cut: true,
  }
}

/** Kill a process and everything it started. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // The shell is what was spawned, and pytest is its child. `/T` is the tree.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** What to run, where, and for how long. */
export interface RunOptions {
  command: string
  cwd: string
  timeoutSeconds: number
  /** Environment for the child. Defaults to this process's, so PATH and keys carry over. */
  env?: NodeJS.ProcessEnv
}

/**
 * Run the command and wait for it, or for the deadline.
 *
 * @param options - The command, the directory it is allowed to run in, and the deadline.
 */
export async function runCommand(options: RunOptions): Promise<RunOutcome> {
  const started = Date.now()
  const child = spawn(options.command, {
    cwd: options.cwd,
    // The command is the deployment's own configuration, so a shell is how it is meant to be read
    // — quoting, pipes and `&&` behave as whoever wrote it expected. Nothing from a caller reaches
    // this string; see the module doc.
    shell: true,
    env: options.env ?? process.env,
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    if (child.pid !== undefined) killTree(child.pid)
  }, Math.max(1, options.timeoutSeconds) * 1000)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
  clearTimeout(deadline)

  const out = bounded(stdout)
  const err = bounded(stderr)
  return {
    command: options.command,
    cwd: options.cwd,
    exitCode,
    timedOut,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stdout: out.text,
    stderr: err.text,
    truncated: out.cut || err.cut,
  }
}
