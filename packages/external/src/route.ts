/**
 * Finding the route a call names, and refusing when the domain says it is not dialable.
 *
 * Everything here happens before anything runs, and it is the half of this capability that makes it
 * a governed act rather than a shell with a friendlier name. The address a call dials is not an
 * argument: it is a field of an object in the deployment's own domain, which is why a model holding
 * this tool cannot point it at a host of its choosing. What a caller supplies is a route id, and the
 * id is looked up in the deployment's graph.
 *
 * Two refusals here are worth reading twice.
 *
 * **The lifecycle's `default_state` is a boundary, not a display filter.** The engine uses it to keep
 * a candidate out of a read, and the temptation is to treat that as a reader's convenience — the
 * route is right there in the graph and dialling it costs nothing. It is not a convenience: the state
 * says nobody has walked this route yet, and a call made through it is a call made on an unverified
 * claim. A route a read would have hidden must not be dialable, so the same declaration is read here.
 * A type that declares no lifecycle hides nothing, and a type whose lifecycle names no default state
 * filters nothing — in both cases there is no boundary to respect and this returns the route.
 *
 * **A missing field is a refusal that names the field.** The deployment configured which field holds
 * the address, so a blank one is not "we could not find the address" — it is the deployment's own
 * configuration pointing at a field its domain left empty. Naming that field is the whole value of
 * the message, because the fix is in the domain rather than in this code.
 *
 * @module @zhangcun123/external/route
 */

import { loadGraph, type OntologyGraph, type OntologyObject } from '@zhangcun123/ontology/engine'

/**
 * The three of the domain's own names this capability has to be told.
 *
 * Nothing else about the customer's world reaches this package: what a route is called, what field
 * holds its address, and what field holds the *name* of the credential. The last one is a name and
 * never the material — the material stays in the host's credential seam, which is the same rule the
 * example domain writes in its schema comment.
 */
export interface RouteShape {
  /** Object type a route is, e.g. `AccessRoute`. */
  type: string
  /** Field holding the address to dial. */
  url: string
  /** Field holding the credential reference name, never the credential. */
  auth_ref: string
}

/** A route resolved far enough to be dialled. */
export interface RouteTarget {
  /** Primary key of the route, as the caller named it. */
  id: string
  /** Declared type it was found in. */
  type: string
  /** The address to dial. */
  url: string
  /** Name the credential is filed under, for the host's seam to resolve. */
  credentialName: string
  /**
   * The object this route reaches, when the domain declares a relation out of the route type.
   *
   * Read from the graph's derived links rather than from a field name this package would have to
   * know, which is the reason it can be reported at all without a fourth configuration key. A route
   * with several outgoing relations reports the first one the domain declares; that is a limit, and
   * it is stated here rather than hidden behind a field that looks authoritative.
   */
  system?: string
}

/**
 * The outcome of looking a route up.
 *
 * A value rather than an exception because every step of the caller's flow refuses for its own
 * reason and has to be written down before it refuses: a thrown error would be caught and re-shaped,
 * and the machine-readable reason would be lost in the process.
 */
export type RouteLookup =
  | { readonly ok: true; readonly route: RouteTarget }
  | { readonly ok: false; readonly reason: string; readonly message: string }

/** Render an unknown thrown value as a single-line message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every id of one type, so a refusal can say what does exist instead of only what does not. */
function availableIds(graph: OntologyGraph, type: string): string {
  const ids = (graph.byType.get(type) ?? []).map((object) => object.id)
  return ids.length === 0 ? 'none' : ids.join(', ')
}

/**
 * The part of a lifecycle this package reads.
 *
 * Structural rather than the engine's own `LifecycleDecl`, which its `schema` subpath does not
 * re-export. The three fields named here are the whole of what decides whether a route is dialable,
 * and a connector that took the rest of the declaration would be holding rules it does not apply —
 * transitions, states, and who may move an object between them are the write path's business.
 */
export interface RouteLifecycle {
  /** Field holding the state. */
  field: string
  /** State an instance is in before anything sets the field. */
  initial: string
  /** State a read assumes when the caller does not ask for one. */
  defaultState?: string
}

/**
 * The state a route is in, as a read computes it.
 *
 * A blank state field is not "no state" in this engine: it is the type's declared `initial` state,
 * which is what a read falls back to, so the same fallback is applied here. Two different answers to
 * "is this route in the default state" is a divergence that shows up exactly when `initial` and
 * `default_state` are the same string — a domain where a read returns a route that has just been
 * created, and a connector that refused to dial it.
 *
 * @param object - The route instance.
 * @param lifecycle - The type's lifecycle declaration.
 * @returns The effective state, and whether it came from the fallback rather than the data.
 */
export function stateOf(
  object: OntologyObject,
  lifecycle: RouteLifecycle,
): { state: string; fromData: boolean } {
  const value = object.data[lifecycle.field]
  if (typeof value === 'string' && value.length > 0) return { state: value, fromData: true }
  return { state: lifecycle.initial, fromData: false }
}

function refuse(reason: string, message: string): RouteLookup {
  return { ok: false, reason, message }
}

/**
 * Look the route up in the deployment's domain.
 *
 * The graph is re-read per call rather than cached at load. That is deliberate and it costs a
 * directory walk: a route is confirmed during a session, and a connector holding a graph from boot
 * would keep refusing the route somebody just walked — with the refusal saying the state is
 * `candidate` while the domain on disk says otherwise, which is worse than a slow answer.
 *
 * @param root - Domain root the deployment configured, the same one the ontology plugin reads.
 * @param routeId - The route the caller named.
 * @param shape - The domain's own names, as configured.
 * @returns The route, or the reason it cannot be dialled and a sentence saying so.
 */
export function resolveRoute(root: string, routeId: string, shape: RouteShape): RouteLookup {
  let graph: OntologyGraph
  try {
    graph = loadGraph(root)
  } catch (error) {
    return refuse(
      'domain-unreadable',
      `the domain at ${root} could not be read (${describe(error)}), so no route can be looked up ` +
        'and nothing was dialled',
    )
  }

  const type = graph.schema.objectTypes.get(shape.type)
  if (type === undefined) {
    const declared = [...graph.schema.objectTypes.keys()]
    return refuse(
      'unknown-route-type',
      `this deployment's route type "${shape.type}" is not declared in the domain at ${root}; ` +
        `it declares ${declared.length === 0 ? 'no object types' : declared.join(', ')}`,
    )
  }

  const object = graph.byId.get(`${type.name}:${routeId}`)
  if (object === undefined) {
    return refuse(
      'unknown-route',
      `no route "${routeId}" in type "${type.name}"; the ids that exist are ` +
        `${availableIds(graph, type.name)}`,
    )
  }

  const lifecycle = type.lifecycle
  if (lifecycle !== undefined && lifecycle.defaultState !== undefined) {
    const { state, fromData } = stateOf(object, lifecycle)
    if (state !== lifecycle.defaultState) {
      return refuse(
        'not-in-default-state',
        `route "${routeId}" is in "${state}" and only a route in "${lifecycle.defaultState}" is ` +
          'dialled — a read of this domain hides it for the same reason, so the route has to reach ' +
          `"${lifecycle.defaultState}" before anything goes through it` +
          (fromData
            ? ''
            : ` (its "${lifecycle.field}" field is empty, which a read takes as "${lifecycle.initial}")`),
      )
    }
  }

  const address = object.data[shape.url]
  if (typeof address !== 'string' || address.length === 0) {
    return refuse(
      'no-address',
      `route "${routeId}" has nothing in its "${shape.url}" field, which this deployment configured ` +
        'as the address to dial; the field has to hold one before the route can be used',
    )
  }

  // The credential's name is read, not judged. Whether it could name a reference at all is the
  // seam's grammar and not this package's, so the blank case is left to the caller that asks the
  // seam — which is also the only place that can say what a name outside the grammar means.
  const credentialName = object.data[shape.auth_ref]

  const link = graph.links.find((candidate) => candidate.fromType === type.name && candidate.from === routeId)
  return {
    ok: true,
    route: {
      id: object.id,
      type: type.name,
      url: address,
      credentialName: typeof credentialName === 'string' ? credentialName : '',
      ...(link === undefined ? {} : { system: link.to }),
    },
  }
}
