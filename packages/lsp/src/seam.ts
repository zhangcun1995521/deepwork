/**
 * What a language-server query is, and the registry that answers one.
 *
 * The ported design keeps two halves apart, and this file is the line between them: a provider
 * answers the four semantic operations and knows nothing about the model, while the tool owns the
 * model-facing name, schema and rendering. That split is why `registerProvider` reserves a
 * branded id and an exclusive set of file extensions rather than registering a tool, and why there
 * is no generic JSON-RPC escape hatch here — a provider swap must not change how the model asks.
 *
 * The fork this comes from made the seam a service so that the backend and the tool could be
 * separate packages. Here they are one package and the seam is still published as `ctx.lsp`, so a
 * second backend can register against the same interface without this tool changing.
 *
 * @module @zhangcun123/lsp/seam
 */

/** The four semantic queries the seam and the model expose. */
export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
export interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}

/** A zero-based UTF-16 half-open range `[start, end)`. */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration, and consumers own timeouts and result limits,
 * so no field needs implementation defaulting.
 */
export interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query: relative to `workspaceRoot` or absolute. */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes. */
  readonly workspaceRoot: string
}

/**
 * A request as a provider receives it: the caller's query plus the `languageId` the registry derived
 * from that provider's extension mapping. The language id only synchronizes the transient document.
 */
export interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}

/** One resolved location: a document URI and the range within it. */
export interface LspLocation {
  /** The target document URI, verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}

/** Normalized hover content, or `null` for no hover at the position. */
export interface LspHover {
  /** The normalized hover text (markdown or plaintext). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}

/**
 * The closed result union. Navigation normalizes to `locations`; hover normalizes to content or
 * `null`. The `locations` variant carries `resolvedWorkspaceUri` — the provider's canonical `file:`
 * URI for the request's workspace root — so a caller relativizes against the world the server saw
 * rather than against a possibly symlinked request path.
 */
export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }

/**
 * Opaque provider identity, reserved atomically with its extension mappings at registration. Branded
 * so a bare string cannot be passed where a reserved id is meant.
 */
export type LspProviderId = string & { readonly [lspProviderIdBrand]: 'LspProviderId' }

declare const lspProviderIdBrand: unique symbol

/**
 * Brand a string as an {@link LspProviderId}. No validation: the registry rejects an empty id at
 * registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function LspProviderId(id: string): LspProviderId {
  return id as LspProviderId
}

/**
 * A language-server backend registered on the seam. `findReferences` always includes declarations,
 * so callers get no flag for it.
 */
export interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The registry has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}

/** The seam itself, published as `ctx.lsp`. */
export interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict or
   * invalid input publishes nothing and throws {@link LspError}.
   * @param provider - the backend to register.
   * @returns the disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's final extension and run one query. Selection is per query and
   * order-independent; no match throws {@link LspError} `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}

/** The stable failure codes the seam and its providers throw. */
export type LspErrorCode =
  | 'LSP_INVALID_PROVIDER'
  | 'LSP_CONFLICT'
  | 'LSP_UNAVAILABLE'
  | 'LSP_DISPOSED'
  | 'LSP_UNSUPPORTED_OPERATION'
  | 'LSP_MALFORMED_RESPONSE'
  | 'LSP_WORKSPACE_REQUIRED'

/**
 * Structured LSP failure carrying a `code` a caller routes on instead of parsing `message`.
 *
 * The harness has its own error base, and the upstream copy of this file extended it — which is what
 * forced a host type import there. A local class carrying the same `code` field is the whole of what
 * a caller uses, and it is what lets this package load with nothing from the host.
 */
export class LspError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: LspErrorCode

  /**
   * @param message - the human-readable failure, shown to whoever asked.
   * @param code - the stable code a caller routes on.
   */
  constructor(message: string, code: LspErrorCode) {
    super(message)
    this.name = 'LspError'
    this.code = code
  }
}

/**
 * Extract a file's final extension as a normalized, lowercase, leading-dot key (`Foo.TS` → `.ts`,
 * `foo.d.ts` → `.ts`). Returns `''` for a name with no extension or a leading-dot dotfile, which no
 * route ever matches. Splits on both separators so a caller's path style does not change the result.
 * @param filePath - the source path to inspect.
 * @returns the normalized extension, or `''` when there is none.
 */
export function finalExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = base.lastIndexOf('.')
  // dot <= 0 covers both "no dot" (-1) and a leading-dot dotfile (0): neither has an extension.
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/** A well-formed normalized extension: a dot followed by one or more non-dot, non-separator chars. */
const EXTENSION_PATTERN = /^\.[^./\\]+$/

/** One selection route: the provider to run plus the language id to synchronize the document with. */
interface Route {
  readonly provider: LspProvider
  readonly languageId: string
}

/**
 * Create the seam: an id and extension reservation table plus per-query routing.
 *
 * Registration validates and conflict-checks everything before mutating, so an invalid or
 * conflicting provider publishes nothing and there is no half-registered route to clean up.
 * @returns the service published as `ctx.lsp`.
 */
export function createLspRegistry(): LspService {
  const providerIds = new Set<LspProviderId>()
  const routes = new Map<string, Route>()

  return {
    registerProvider(provider: LspProvider): () => void {
      const id = provider.id
      if (id.trim() === '') {
        throw new LspError('an LSP provider id must be a non-empty string', 'LSP_INVALID_PROVIDER')
      }
      if (providerIds.has(id)) {
        throw new LspError(`an LSP provider with id "${id}" is already registered`, 'LSP_CONFLICT')
      }

      const entries = Object.entries(provider.extensionToLanguage)
      if (entries.length === 0) {
        throw new LspError(`LSP provider "${id}" registers no file extensions`, 'LSP_INVALID_PROVIDER')
      }

      // Normalize into this provider's own route set, catching intra-provider duplicates (`.TS` and
      // `.ts`) before cross-provider conflicts.
      const pending = new Map<string, Route>()
      for (const [rawExtension, languageId] of entries) {
        const extension = rawExtension.toLowerCase()
        const normalized = extension.startsWith('.') ? extension : `.${extension}`
        if (!EXTENSION_PATTERN.test(normalized)) {
          throw new LspError(`LSP provider "${id}" maps an invalid extension "${rawExtension}"`, 'LSP_INVALID_PROVIDER')
        }
        if (languageId.trim() === '') {
          throw new LspError(`LSP provider "${id}" maps extension "${normalized}" to an empty language id`, 'LSP_INVALID_PROVIDER')
        }
        if (pending.has(normalized)) {
          throw new LspError(`LSP provider "${id}" maps extension "${normalized}" more than once`, 'LSP_INVALID_PROVIDER')
        }
        pending.set(normalized, { provider, languageId })
      }
      for (const extension of pending.keys()) {
        if (routes.has(extension)) {
          throw new LspError(`extension "${extension}" is already handled by another LSP provider`, 'LSP_CONFLICT')
        }
      }

      providerIds.add(id)
      for (const [extension, route] of pending) routes.set(extension, route)
      return () => {
        providerIds.delete(id)
        for (const extension of pending.keys()) routes.delete(extension)
      }
    },

    async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
      const route = routes.get(finalExtension(request.filePath))
      if (route === undefined) {
        throw new LspError(`no LSP provider handles "${request.filePath}"`, 'LSP_UNAVAILABLE')
      }
      return route.provider.query({ ...request, languageId: route.languageId }, signal)
    },
  }
}
