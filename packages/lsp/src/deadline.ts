/**
 * Cancellation and deadline helpers shared by the queue, the source read, and the protocol phases.
 *
 * Two different things are bounded here, and they are not the same bound. A **deadline** is a
 * budget this client arms for one phase — a graceful shutdown, a cancellation grace. An
 * **abortable wait** is a caller's signal abandoning its wait for work that keeps running to its own
 * owner-defined boundary; it must never claim the work stopped.
 *
 * @module @zhangcun123/lsp/deadline
 */

/** A live deadline: the signal to race against, and the way to disarm it. */
export interface Deadline {
  readonly signal: AbortSignal
  /** Disarm the timer. Idempotent. */
  dispose(): void
}

/**
 * Arm a deadline that aborts with an `Error` naming the label and the budget.
 * @param milliseconds - the budget; a positive integer.
 * @param label - what the budget covers, named in the abort reason.
 * @returns the deadline; dispose it when the phase it bounds settles.
 */
export function deadline(milliseconds: number, label: string): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${milliseconds}ms`))
  }, milliseconds)
  // A budget that outlives the phase it bounds would hold a one-shot process open for a server that
  // is already gone.
  timer.unref()
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer)
    },
  }
}

/**
 * Build an abort Error carrying the signal's reason.
 * @param signal - the aborted signal whose reason to surface.
 * @returns the Error reason, else a generic aborted Error.
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('LSP query aborted')
}

/**
 * Throw the signal's abort error when it has already fired.
 * @param signal - the optional cancellation signal.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * Await work while allowing a signal to abandon its wait; the underlying work keeps its own handlers
 * and continues to its owner-defined quiescence boundary.
 * @param work - the owned asynchronous work.
 * @param signal - optional cancellation.
 * @returns the work result, or a rejection carrying the abort reason.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(abortError(signal))
  let onAbort: () => void = () => {}
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => { reject(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const normalized = work.catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error))
  })
  return Promise.race([normalized, canceled])
    .finally(() => { signal.removeEventListener('abort', onAbort) })
}
