/**
 * @deepwork/probe — the smallest thing that can prove the plugin route works.
 *
 * It answers four questions in order, and records how far it got:
 *   1. Was this package resolved and its `apply` invoked?      -> marker file
 *   2. Could it reach the cordis context?                       -> ctx presence
 *   3. Could it register on a real service (ctx.tools)?         -> tool registration
 *   4. Does the registry actually hold the tool afterwards?     -> ctx.tools.get()
 *
 * Every step is recorded, and a failure later does not erase the evidence from
 * earlier steps. The probe never throws: one that crashes the host tells you
 * less than one that reports what it could not do.
 *
 * Registered as a raw ToolDefinition (no `defineTool` import), so the probe
 * stays dependency-free and cannot fail for a resolution reason.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Plugin name as DSH's loader sees it in logs and error messages. */
export const name = 'deepwork-probe'

/**
 * Declared so the loader keeps this plugin pending until the tool registry
 * exists. Without `tools` here, `ctx.tools` throws
 * "cannot get property tools without inject" rather than waiting.
 */
export const inject = ['tools']

const TOOL_NAME = 'deepwork_probe'

/** Resolve the marker path; env override lets the harness put it anywhere. */
function markerPath() {
  return process.env.DEEPWORK_PROBE_MARKER ?? resolve(process.cwd(), 'deepwork-probe-mounted.txt')
}

/** Write the marker with one recorded fact per line. */
function record(lines) {
  const target = markerPath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
    process.stderr.write(`[deepwork-probe] mounted -> ${target}\n`)
  } catch (error) {
    process.stderr.write(`[deepwork-probe] marker write failed: ${error}\n`)
  }
}

/**
 * Probe body. `ctx` is the cordis context; in cordis a plugin is just a
 * function that runs once at mount time and may register services, tools,
 * listeners, or effects against it.
 */
export function apply(ctx) {
  const findings = [
    `mounted_at=${new Date().toISOString()}`,
    `cwd=${process.cwd()}`,
    `pid=${process.pid}`,
    `ctx_present=${Boolean(ctx)}`,
  ]

  // Step 3: register a real, harmless tool. This is the strongest signal
  // short of a model turn: DSH validated our schema and would publish it to
  // the model's tool catalog.
  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description: 'Probe tool registered by @deepwork/probe. Returns a fixed acknowledgement.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, marker: { type: 'string' } },
          required: ['ok', 'marker'],
        },
        render: (_args, value) => [
          { type: 'text', text: `deepwork probe ok=${value.ok} marker=${value.marker}` },
        ],
      },
      execute: async () => ({ ok: true, marker: markerPath() }),
    })
    findings.push('tool_registered=true')
  } catch (error) {
    findings.push(`tool_registration_failed=${error}`)
  }

  // Step 4: ask the registry whether it holds the tool. `get()` is the direct
  // answer; `schemas()` is scope-filtered, so a zero there is not a failure.
  try {
    findings.push(`registry_has_tool=${Boolean(ctx.tools.get(TOOL_NAME))}`)
  } catch (error) {
    findings.push(`registry_get_failed=${error}`)
  }

  try {
    const schemas = ctx.tools.schemas() ?? []
    findings.push(`schemas_in_scope=${schemas.length}`)
    findings.push(`schemas_sample=${schemas.slice(0, 8).map((s) => s.name).join(',')}`)
  } catch (error) {
    findings.push(`schemas_failed=${error}`)
  }

  record(findings)
}
