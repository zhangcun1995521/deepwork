/**
 * Running the deployment's connector, once, with limits.
 *
 * Copied in shape from `@zhangcun123/test-runner/run`, because the three limits are the same three
 * for the same reasons. The command is configuration and nothing a model said reaches it. Nothing
 * runs forever: a connector waiting on a gateway that never answers must not take the agent's turn
 * with it, so every run has a deadline and the deadline kills the whole process tree — on Windows a
 * shell keeps its children, and killing the shell alone leaves the program holding the socket, the
 * temp file and the CPU. And output is bounded, because a proxy answering with a megabyte of HTML
 * would crowd out everything else in a context window; the cap is reported inside the text rather
 * than applied quietly, so a reader knows the rest exists.
 *
 * One thing is not copied, and it is why this file exists instead of an import.
 *
 * **The credential travels in the environment.** The obvious shape — append it to the command the
 * deployment configured — writes the secret into a string that the host logs, that the process
 * table shows to every user of the machine, and that turns up in every error message about the
 * command. The environment is not perfectly private either, but nothing reads it off a process
 * listing, and it is the seam connector libraries already look in.
 *
 * The name matters as much as the mechanism. It holds no `KEY`, `PASSWORD`, `SECRET` or `TOKEN`,
 * because the harness scrubs those names out of a child's environment (`SENSITIVE_ENV_PATTERN` in
 * `@deepseek-ai/dsh-subprocess`). That is the pitfall the deployment's own connection notes record:
 * a credential filed under such a name arrives empty and reads as one nobody set, which is a failure
 * with no error message anywhere in it.
 *
 * What this file does not do is scrub the ambient environment. The spawn is direct rather than
 * through the host's subprocess service, so the child inherits whatever this process has — the
 * harness's own key included, if it is in there. That scrub belongs to the service being bypassed,
 * and copying its heuristic here would be a second policy to keep in step. A deployment that must
 * not hand its own environment to a connector should say so where the command is configured.
 *
 * @module @zhangcun123/external/run
 */

import { spawn } from 'node:child_process'

/** What one run of the deployment's connector produced. */
export interface ReachRun {
  /** The command line as it was run, with the address already substituted. */
  command: string
  cwd: string
  /** The exit status, or null when the program was killed before it had one. */
  exitCode: number | null
  /** True when the deadline was reached and the tree was killed. */
  timedOut: boolean
  /** Wall-clock time from spawn to exit. */
  elapsedMs: number
  stdout: string
  stderr: string
  /** True when either stream was cut. The text carried says how much is missing. */
  truncated: boolean
}

/** How much of a stream is kept before it is cut, in characters. */
export const STREAM_LIMIT = 20_000

/**
 * The environment name the credential is handed over under.
 *
 * Neutral on purpose; see the module doc for what happens to a name that is not.
 */
export const CREDENTIAL_ENV = 'DEEPWORK_REACH_CREDENTIAL'

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
    // The shell is what was spawned, and the connector is its child. `/T` is the tree.
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
  /** The command line, already carrying the substituted address. */
  command: string
  cwd: string
  timeoutSeconds: number
  /**
   * Environment for the child.
   *
   * Given rather than defaulted, because this is where the credential travels and a default would
   * be the one place a caller could forget it. Reading the process environment is left to the
   * caller so the composition (and not this file) decides what the connector can see.
   */
  env: NodeJS.ProcessEnv
}

/**
 * Run the program and wait for it, or for the deadline.
 *
 * @param options - The command line, the directory it runs in, the deadline and the environment.
 * @returns What the program did: its status, its output, and how long it took.
 */
export async function runCommand(options: RunOptions): Promise<ReachRun> {
  const started = Date.now()
  const child = spawn(options.command, {
    cwd: options.cwd,
    // A shell, because the command is the deployment's own configuration and is meant to be read
    // the way whoever wrote it read it — quoting and flags included. What reaches this string is
    // that configuration plus one address out of the domain, and the address is quoted and checked
    // before it gets here; see `substituteAddress`.
    shell: true,
    env: options.env,
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
    elapsedMs: Date.now() - started,
    stdout: out.text,
    stderr: err.text,
    truncated: out.cut || err.cut,
  }
}
