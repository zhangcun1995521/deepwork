/**
 * DeepWork workspace — the server behind the UI.
 *
 * It reads a domain with the ontology engine and reports what the engine derived from
 * it: the entities, the relations, and above all the *tool surface* the agent would be
 * given, down to the JSON Schema of each argument. The point of this app is to make the
 * derivation visible — the engine's whole claim is that a domain is data, and the way
 * to check a claim like that is to look at what comes out the other end.
 *
 * No DSH dependency, no runtime to boot, no API key: the engine is a pure library over
 * a directory of YAML. That is why this server has nothing in common with the plugin's
 * own boot path, and why it starts instantly.
 *
 * Domains are read from disk, and a path arriving from a browser is an arbitrary-read
 * request. So the set of readable domains is an allowlist: whatever `DEEPWORK_DOMAINS`
 * names, plus the example shipped with the engine. Anything else is refused rather than
 * read.
 *
 * @module @deepwork/workspace/server
 */

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGraph } from '@zhangcun123/ontology/engine'
import { deriveTools } from '@zhangcun123/ontology/tools'
import { deriveWriteTools } from '@zhangcun123/ontology/tools/write'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const PORT = Number(process.env.PORT ?? 4180)

/** Where the engine's own package lives, so its bundled example can be allowed. */
const ENGINE_DIR = dirname(createRequire(import.meta.url).resolve('@zhangcun123/ontology/package.json'))

/**
 * Domains this server will read.
 *
 * An absolute allowlist rather than a path check, because "is this inside a parent
 * directory" is the kind of rule that is right until it is not. Listing the readable
 * roots is a rule that cannot be talked around.
 */
const DOMAINS = [
  join(ENGINE_DIR, 'examples', 'project-delivery'),
  ...(process.env.DEEPWORK_DOMAINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
].map((entry) => resolve(entry))

/** HTTP status text for a JSON error body. */
function fail(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify({ error: message }, null, 2)}\n`)
}

/** Send a JSON body. */
function json(response, body) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body, null, 2)}\n`)
}

/** Resolve a requested domain against the allowlist, or explain why not. */
function resolveDomain(requested) {
  if (requested === undefined || requested.length === 0) {
    return { ok: false, status: 400, message: 'a "root" query parameter is required' }
  }
  const wanted = resolve(requested)
  const allowed = DOMAINS.find((domain) => domain === wanted)
  if (allowed !== undefined) return { ok: true, root: allowed }
  return {
    ok: false,
    status: 403,
    message:
      `${wanted} is not a readable domain. This server reads an allowlist; ` +
      `add it to DEEPWORK_DOMAINS to read it. Allowed: ${DOMAINS.join(', ')}`,
  }
}

/** The audit trail beside a domain, if it has one. */
function readAudit(root) {
  const path = join(root, '.audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        // A half-written final line is normal for an append-only log; report it rather
        // than dropping it silently.
        return { parseError: true, raw: line }
      }
    })
}

/**
 * Everything the UI shows for one domain, in one response.
 *
 * Shape is deliberately the engine's own vocabulary — object types, link types, tool
 * definitions — rather than a presentation model. The UI's job is to show what the
 * engine produced, so translating it here would hide exactly what is worth looking at.
 */
function inspect(root, roles) {
  const startedLoad = process.hrtime.bigint()
  const graph = loadGraph(root)
  const loadMs = Number(process.hrtime.bigint() - startedLoad) / 1e6

  const startedDerive = process.hrtime.bigint()
  const reads = deriveTools(graph)
  // Writes are shown only when a role map is supplied, mirroring the plugin: with no
  // roles there is no write tool at all, rather than one that refuses everything.
  const writes =
    roles.length === 0
      ? { tools: [], warnings: [] }
      : deriveWriteTools(graph, { roles, audit: () => {} })
  const deriveMs = Number(process.hrtime.bigint() - startedDerive) / 1e6

  return {
    root,
    summary: {
      objects: graph.objects.length,
      links: graph.links.length,
      objectTypes: graph.schema.objectTypes.size,
      linkTypes: graph.schema.linkTypes.size,
      declaredFunctions: Object.keys(graph.schema.functions).length,
      declaredActions: Object.keys(graph.schema.actionTypes).length,
      readTools: reads.tools.length,
      writeTools: writes.tools.length,
      loadMs: Number(loadMs.toFixed(1)),
      deriveMs: Number(deriveMs.toFixed(1)),
    },
    warnings: {
      load: graph.warnings,
      derivation: [...reads.warnings, ...writes.warnings],
    },
    objectTypes: [...graph.schema.objectTypes.values()].map((type) => ({
      name: type.name,
      primaryKey: type.primaryKey,
      primaryKeySource: type.primaryKeySource,
      requiredFields: type.requiredFields,
      directory: type.directory,
      fileLocation: type.fileLocation,
      writtenBy: type.writtenBy,
      fields: type.fields,
      instances: (graph.byType.get(type.name) ?? []).length,
    })),
    linkTypes: [...graph.schema.linkTypes.values()].map((link) => ({
      name: link.name,
      from: link.from,
      to: link.to,
      // `field` is what edge derivation actually reads; `via` is when it differs from
      // the relation's own name. Showing both makes that rule visible instead of
      // mysterious.
      field: link.field,
      ...(link.via === undefined ? {} : { via: link.via }),
      ...(link.description === undefined ? {} : { description: link.description }),
      edges: graph.links.filter((candidate) => candidate.type === link.name).length,
    })),
    // The tool definitions exactly as they would be handed to the runtime — including
    // the JSON Schemas, because the schemas are the part the model actually reads.
    tools: {
      read: reads.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        outputSchema: tool.outputSchema,
      })),
      write: writes.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        outputSchema: tool.outputSchema,
      })),
    },
    entities: graph.objects.map((object) => ({
      type: object.type,
      id: object.id,
      key: object.key,
      file: object.file,
      data: object.data,
    })),
    links: graph.links,
    audit: readAudit(root),
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Serve one file from `public/`, refusing anything that leaves it. */
function serveStatic(response, name) {
  const target = resolve(PUBLIC_DIR, name === '/' ? 'index.html' : name.slice(1))
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    return fail(response, 403, 'refusing to serve outside the public directory')
  }
  if (!existsSync(target)) return fail(response, 404, `no such file: ${name}`)
  const extension = target.slice(target.lastIndexOf('.'))
  response.writeHead(200, { 'content-type': MIME[extension] ?? 'application/octet-stream' })
  response.end(readFileSync(target))
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  try {
    if (url.pathname === '/api/domains') {
      return json(
        response,
        DOMAINS.filter(existsSync).map((root) => ({
          root,
          label: root.slice(Math.max(root.lastIndexOf(sep) + 1)),
        })),
      )
    }

    if (url.pathname === '/api/inspect') {
      const domain = resolveDomain(url.searchParams.get('root') ?? undefined)
      if (!domain.ok) return fail(response, domain.status, domain.message)

      const rawRoles = url.searchParams.get('roles')
      let roles = []
      if (rawRoles !== null && rawRoles.length > 0) {
        try {
          roles = JSON.parse(rawRoles)
          if (!Array.isArray(roles)) throw new Error('expected an array')
        } catch (error) {
          return fail(response, 400, `"roles" must be a JSON array of {prefix, role}: ${error.message}`)
        }
      }

      return json(response, inspect(domain.root, roles))
    }

    if (url.pathname.startsWith('/api/')) return fail(response, 404, `no such endpoint: ${url.pathname}`)
    return serveStatic(response, url.pathname)
  } catch (error) {
    // A schema that cannot be read throws by design; surfacing the message is the whole
    // point of that design, so it goes to the caller rather than to a log.
    return fail(response, 500, error instanceof Error ? error.message : String(error))
  }
})

server.listen(PORT, () => {
  process.stdout.write(`DeepWork workspace on http://127.0.0.1:${PORT}\n`)
  process.stdout.write(`domains:\n${DOMAINS.map((root) => `  ${root}\n`).join('')}`)
})
