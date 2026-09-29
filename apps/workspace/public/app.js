/**
 * The workspace UI.
 *
 * It renders one thing: what the engine produced from a domain. The tool definitions
 * are shown as the runtime receives them — name, prose, and the argument schema — because
 * the schema is the part the model actually reads, and a hand-written summary of it would
 * hide the very thing worth inspecting.
 *
 * No framework and no build step. The page is a viewer over a JSON document, and a
 * viewer does not need a bundler.
 */

const $ = (id) => document.getElementById(id)

/** Escape text before it reaches the DOM. Domain data is local, but local is not trusted. */
function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** One panel with a title and a note on the right. */
function panel(title, note, body) {
  return `<section class="panel"><h2>${esc(title)}<em>${esc(note ?? '')}</em></h2>
    <div class="body">${body}</div></section>`
}

/** A table from a header list and row arrays (each row already escaped HTML). */
function table(headers, rows) {
  if (rows.length === 0) return '<p class="note">nothing to show</p>'
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

/** Render a JSON Schema's arguments as a table. */
function renderArguments(schema) {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const names = Object.keys(properties)
  if (names.length === 0) return '<p class="note">takes no arguments</p>'

  const rows = names.map((name) => {
    const node = properties[name] ?? {}
    const enumBlock = Array.isArray(node.enum)
      ? `<span class="enum">${esc(node.enum.join(' | '))}</span>`
      : ''
    return [
      `<span class="name-inner">${esc(name)}</span>${required.has(name) ? '<span class="req">required</span>' : ''}`,
      esc(node.type ?? 'any') + enumBlock,
      esc(node.description ?? ''),
    ]
  })
  return table(['argument', 'type', 'meaning'], rows)
}

/** One tool definition. */
function renderTool(tool, kind) {
  return `<article class="tool">
    <header><code>${esc(tool.name)}</code><span class="kind">${esc(kind)}</span></header>
    <div class="doc">${esc(tool.description)}</div>
    <div class="args">${renderArguments(tool.parameters)}</div>
  </article>`
}

/** The tool surface — the reason this app exists. */
function renderTools(data) {
  const reads = data.tools.read
  const writes = data.tools.write

  const readBody = reads.map((tool) => renderTool(tool, 'read')).join('')
  const writeBody =
    writes.length > 0
      ? writes.map((tool) => renderTool(tool, 'write')).join('')
      : `<p class="note">No write tool. Writes are gated by the role map, and with none
         configured the tool is not registered at all — an unconfigured deployment is a
         read-only one, rather than one that refuses every call.<br><br>
         Put a role map in the <code>roles</code> box above and inspect again, e.g.
         <code>[{"prefix":"session-","role":"delivery-lead"}]</code></p>`

  return panel(
    'Tool surface',
    `${reads.length + writes.length} tool${reads.length + writes.length === 1 ? '' : 's'} — this is what the agent sees`,
    readBody + writeBody,
  )
}

/** Object types, with the declarations that govern writes. */
function renderTypes(data) {
  const rows = data.objectTypes.map((type) => [
    `<span class="name-inner">${esc(type.name)}</span>`,
    esc(String(type.instances)),
    `<span class="type-inline">${esc(type.primaryKey)}</span>`,
    esc(type.requiredFields.join(', ') || '—'),
    type.writtenBy.length > 0
      ? esc(type.writtenBy.join(', '))
      : '<span class="desc">nobody — writes refused</span>',
    `<span class="desc">${esc(type.directory)}</span>`,
  ])
  return panel('Object types', `${data.objectTypes.length} declared`, table(
    ['type', 'instances', 'identity', 'required fields', 'may be written by', 'directory'],
    rows,
  ))
}

/**
 * Relations, showing the field each one reads.
 *
 * `via` is surfaced rather than hidden because it is the rule most likely to explain a
 * relation that returns nothing: when the field name and the relation name differ and
 * no `via` says so, the relation silently matches nothing.
 */
function renderRelations(data) {
  const rows = data.linkTypes.map((link) => [
    `<span class="name-inner">${esc(link.name)}</span>`,
    `<span class="type-inline">${esc(link.from)} → ${esc(link.to)}</span>`,
    `<span class="type-inline">${esc(link.field)}</span>` +
      (link.via === undefined ? '' : '<span class="desc"> (via)</span>'),
    esc(String(link.edges)),
    `<span class="desc">${esc(link.description ?? '')}</span>`,
  ])
  return panel('Relations', `${data.linkTypes.length} declared`, table(
    ['relation', 'direction', 'reads field', 'edges', 'meaning'],
    rows,
  ))
}

/** Warnings, rendered with the same weight the engine gives them. */
function renderWarnings(data) {
  const all = [...data.warnings.load, ...data.warnings.derivation]
  if (all.length === 0) {
    return panel('Warnings', 'none', '<p class="note">the domain loaded cleanly and every declaration was usable</p>')
  }
  return panel('Warnings', `${all.length}`, `<ul class="warn-list">${all.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`)
}

/** The audit trail, if this domain has been written to. */
function renderAudit(data) {
  if (data.audit.length === 0) return ''
  const rows = data.audit.slice(-40).reverse().map((entry) => {
    if (entry.parseError) return ['—', '—', '—', 'unparseable', `<span class="desc">${esc(entry.raw)}</span>`]
    const outcome =
      entry.outcome === 'allowed'
        ? '<span style="color:var(--ok)">allowed</span>'
        : `<span style="color:var(--deny)">denied</span>`
    return [
      `<span class="desc">${esc(entry.at ?? '')}</span>`,
      esc(entry.role ?? '—'),
      esc(`${entry.type}:${entry.id}`),
      outcome,
      `<span class="desc">${esc(entry.reason ?? (entry.fields ?? []).join(', '))}</span>`,
    ]
  })
  return panel('Audit trail', `${data.audit.length} attempts recorded`, table(
    ['at', 'role', 'target', 'outcome', 'reason / fields'],
    rows,
  ))
}

/** The strip of counts above the fold. */
function renderSummary(data) {
  const s = data.summary
  const stats = [
    ['objects', s.objects, ''],
    ['relations', s.links, ''],
    ['object types', s.objectTypes, ''],
    ['link types', s.linkTypes, ''],
    ['declared functions', s.declaredFunctions, ''],
    ['read tools', s.readTools, 'ok'],
    ['write tools', s.writeTools, s.writeTools === 0 ? 'deny' : 'ok'],
  ]
  $('summary').innerHTML = stats
    .map(([label, value, cls]) => `<div class="stat ${cls}"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`)
    .join('')
}

/** Fetch and render one domain. */
async function inspect() {
  const root = $('domain').value
  const roles = $('roles').value.trim()
  const out = $('out')
  out.innerHTML = '<p class="note">loading…</p>'

  const query = new URLSearchParams({ root })
  if (roles.length > 0) query.set('roles', roles)

  let response
  let data
  try {
    response = await fetch(`/api/inspect?${query}`)
    data = await response.json()
  } catch (error) {
    out.innerHTML = panel('Request failed', '', `<p class="note">${esc(String(error))}</p>`)
    return
  }

  // An error from the engine is shown, not swallowed: a schema that cannot be read
  // throws by design, and hiding that would defeat the reason it throws.
  if (!response.ok) {
    out.innerHTML = panel(`Engine refused (${response.status})`, '', `<p class="note">${esc(data.error ?? 'unknown')}</p>`)
    $('summary').innerHTML = ''
    return
  }

  renderSummary(data)
  out.innerHTML = [
    renderTools(data),
    renderTypes(data),
    renderRelations(data),
    renderWarnings(data),
    renderAudit(data),
  ].join('')

  $('foot').innerHTML =
    `domain <code>${esc(data.root)}</code> · loaded in ${data.summary.loadMs} ms, derived in ${data.summary.deriveMs} ms` +
    ` · ${data.summary.objects} entities, ${data.summary.links} relations`
}

/** Populate the domain picker, then show the first domain. */
async function boot() {
  $('roles').placeholder = '[{"prefix":"session-","role":"delivery-lead"}]'
  $('reload').addEventListener('click', inspect)
  $('roles').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') inspect()
  })

  const domains = await (await fetch('/api/domains')).json()
  if (domains.length === 0) {
    $('out').innerHTML = panel(
      'No readable domains',
      '',
      '<p class="note">Nothing is in the allowlist. Start the server with <code>DEEPWORK_DOMAINS=/path/to/domain</code>.</p>',
    )
    return
  }
  $('domain').innerHTML = domains
    .map((d) => `<option value="${esc(d.root)}">${esc(d.label)} — ${esc(d.root)}</option>`)
    .join('')
  await inspect()
}

boot()
