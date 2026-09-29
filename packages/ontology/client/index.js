/**
 * DeepWork ontology plugin — browser half.
 *
 * It renders what the engine derived, read from the plugin's own host half at
 * `/deepwork/domain`. One process, one origin, no second server and no RPC layer: the
 * host already holds the loaded graph, so it is the only thing that has the data.
 *
 * Hand-written rather than bundled: DSH's client preset resolves packages by globbing
 * `packages/* .../package.json` inside the DSH repository and throws for anything laid
 * out otherwise, so an outside package has to produce the artifact itself. The contract
 * is small — a CJS body wrapped in `window.__ModuleLoader__.load({ id, factory })`, with
 * `id` equal to this package's name because the runtime asserts registration under it —
 * and `exports["./client"]` may name any relative path, so no build step is needed.
 *
 * Styling is deliberately relative: borders and fills derive from `currentColor`, so the
 * panel follows whichever theme DSH is wearing instead of imposing one. A plugin that
 * hardcodes a palette looks broken in half the themes it can be installed into.
 */
window.__ModuleLoader__.load({
  id: '@zhangcun123/ontology',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    /** Shared by the nav row and the page; also the `main` slot key. */
    const PANEL_ID = 'deepwork-ontology'

    /** The product's own name, and the shell's build-time name it replaces. */
    const PRODUCT_NAME = 'DeepWork'
    const PRODUCT_TITLE_FROM = 'DeepSeek Harness'

    /** Where the host half serves this domain. */
    const DOMAIN_URL = '/deepwork/domain'

    const LINE = '1px solid color-mix(in srgb, currentColor 18%, transparent)'
    const HAIRLINE = '1px solid color-mix(in srgb, currentColor 10%, transparent)'
    const WASH = 'color-mix(in srgb, currentColor 4%, transparent)'
    const MUTED = { opacity: 0.65 }
    const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace'
    const ACCENT = 'color-mix(in srgb, currentColor 100%, transparent)'

    /** Section with a small heading. */
    function Section(props) {
      return react.createElement(
        'section',
        { style: { marginTop: 26 } },
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              marginBottom: 8,
              paddingBottom: 5,
              borderBottom: HAIRLINE,
            },
          },
          react.createElement(
            'h2',
            {
              style: {
                margin: 0,
                fontSize: 11,
                letterSpacing: '.7px',
                textTransform: 'uppercase',
                fontWeight: 600,
                opacity: 0.75,
              },
            },
            props.title,
          ),
          props.note === undefined
            ? null
            : react.createElement('span', { style: { ...MUTED, fontSize: 11.5 } }, props.note),
        ),
        props.children,
      )
    }

    /** A dense table. Rows are arrays of React nodes. */
    function Table(props) {
      if (props.rows.length === 0) {
        return react.createElement('p', { style: { ...MUTED, fontSize: 12.5 } }, 'nothing to show')
      }
      const cell = { padding: '5px 10px 5px 0', verticalAlign: 'top', fontSize: 12.5 }
      return react.createElement(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse' } },
        react.createElement(
          'thead',
          null,
          react.createElement(
            'tr',
            null,
            props.headers.map((header) =>
              react.createElement(
                'th',
                {
                  key: header,
                  style: {
                    ...cell,
                    textAlign: 'left',
                    fontSize: 10.5,
                    letterSpacing: '.5px',
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    opacity: 0.55,
                    whiteSpace: 'nowrap',
                  },
                },
                header,
              ),
            ),
          ),
        ),
        react.createElement(
          'tbody',
          null,
          props.rows.map((row, index) =>
            react.createElement(
              'tr',
              {
                key: index,
                style: { borderTop: index === 0 ? 'none' : HAIRLINE },
              },
              row.map((value, column) =>
                react.createElement('td', { key: column, style: cell }, value),
              ),
            ),
          ),
        ),
      )
    }

    /** Monospace text, used for identifiers and types. */
    function Code(props) {
      return react.createElement(
        'span',
        { style: { fontFamily: MONO, fontSize: 12, ...(props.muted ? MUTED : {}) } },
        props.children,
      )
    }

    /** Render a JSON Schema's arguments as a table — the part the model actually reads. */
    function Arguments(props) {
      const properties = (props.schema && props.schema.properties) || {}
      const required = new Set((props.schema && props.schema.required) || [])
      const names = Object.keys(properties)
      if (names.length === 0) {
        return react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12, margin: '4px 0 0' } },
          'takes no arguments',
        )
      }
      const rows = names.map((name) => {
        const node = properties[name] || {}
        const values = Array.isArray(node.enum)
          ? react.createElement(
              'div',
              { style: { fontFamily: MONO, fontSize: 11, opacity: 0.8, marginTop: 1 } },
              node.enum.join(' | '),
            )
          : null
        return [
          react.createElement(
            'span',
            { key: 'n' },
            react.createElement(Code, null, name),
            required.has(name)
              ? react.createElement(
                  'span',
                  { style: { fontSize: 10, marginLeft: 5, opacity: 0.6 } },
                  'required',
                )
              : null,
          ),
          react.createElement(
            'span',
            { key: 't' },
            react.createElement(Code, { muted: true }, node.type || 'any'),
            values,
          ),
          react.createElement('span', { key: 'd', style: { ...MUTED, fontSize: 12 } }, node.description || ''),
        ]
      })
      return react.createElement(Table, { headers: ['argument', 'type', 'meaning'], rows })
    }

    /** One tool definition. */
    function ToolCard(props) {
      const tool = props.tool
      return react.createElement(
        'article',
        { style: { border: LINE, borderRadius: 8, marginTop: 10, overflow: 'hidden' } },
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 11px',
              background: WASH,
              borderBottom: HAIRLINE,
            },
          },
          react.createElement(Code, null, tool.name),
          react.createElement(
            'span',
            {
              style: {
                marginLeft: 'auto',
                fontSize: 10,
                letterSpacing: '.5px',
                textTransform: 'uppercase',
                opacity: 0.55,
              },
            },
            props.kind,
          ),
        ),
        react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12.5, margin: '9px 11px' } },
          tool.description,
        ),
        react.createElement(
          'div',
          { style: { padding: '0 11px 9px' } },
          react.createElement(Arguments, { schema: tool.parameters }),
        ),
      )
    }

    /** The counter strip. */
    function Summary(props) {
      const s = props.summary
      const stats = [
        ['objects', s.objects],
        ['relations', s.links],
        ['object types', s.objectTypes],
        ['link types', s.linkTypes],
        ['declared functions', s.declaredFunctions],
        ['read tools', s.readTools],
        ['write tools', s.writeTools],
      ]
      return react.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 22px', margin: '10px 0 0' } },
        stats.map(([label, value], index) =>
          react.createElement(
            'div',
            { key: index, style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
            react.createElement(
              'b',
              { style: { fontFamily: MONO, fontSize: 15, fontWeight: 600 } },
              String(value),
            ),
            react.createElement(
              'span',
              { style: { ...MUTED, fontSize: 10.5, letterSpacing: '.4px', textTransform: 'uppercase' } },
              label,
            ),
          ),
        ),
      )
    }

    /** Body for a domain snapshot. */
    function Domain(props) {
      const data = props.data
      const warnings = data.warnings.load.concat(data.warnings.derivation)
      const tools = data.tools.read.concat(data.tools.write)

      return react.createElement(
        'div',
        null,
        react.createElement('code', { style: { fontFamily: MONO, fontSize: 11.5, ...MUTED } }, data.root),
        react.createElement(Summary, { summary: data.summary }),

        react.createElement(
          Section,
          {
            title: 'Tool surface',
            note: tools.length + ' tools — this is what the agent is given',
          },
          tools.map((tool) =>
            react.createElement(ToolCard, {
              key: tool.name,
              tool: tool,
              kind: data.tools.write.indexOf(tool) >= 0 ? 'write' : 'read',
            }),
          ),
          data.tools.write.length === 0
            ? react.createElement(
                'p',
                { style: { ...MUTED, fontSize: 12.5, marginTop: 12 } },
                'No write tool. Writes are gated by the role map, and with none configured the ' +
                  'tool is not registered at all — an unconfigured deployment is a read-only one, ' +
                  'rather than one that refuses every call. Put a role map in the box above, e.g. ' +
                  '[{"prefix":"session-","role":"delivery-lead"}], to see it appear.',
              )
            : null,
        ),

        react.createElement(
          Section,
          { title: 'Object types', note: data.objectTypes.length + ' declared' },
          react.createElement(Table, {
            headers: ['type', 'instances', 'identity', 'required', 'may be written by', 'directory'],
            rows: data.objectTypes.map((type) => [
              react.createElement(Code, null, type.name),
              String(type.instances),
              react.createElement(Code, { muted: true }, type.primaryKey),
              react.createElement('span', { style: { ...MUTED, fontSize: 12 } }, type.requiredFields.join(', ') || '—'),
              type.writtenBy.length > 0
                ? react.createElement(Code, null, type.writtenBy.join(', '))
                : react.createElement('span', { style: { ...MUTED, fontSize: 12 } }, 'nobody'),
              react.createElement('span', { style: { ...MUTED, fontSize: 12 } }, type.directory),
            ]),
          }),
        ),

        react.createElement(
          Section,
          {
            title: 'Relations',
            note: 'the field each one reads is what explains an empty result',
          },
          react.createElement(Table, {
            headers: ['relation', 'direction', 'reads field', 'edges', 'meaning'],
            rows: data.linkTypes.map((link) => [
              react.createElement(Code, null, link.name),
              react.createElement(Code, { muted: true }, link.from + ' → ' + link.to),
              react.createElement(
                'span',
                null,
                react.createElement(Code, null, link.field),
                link.via === undefined
                  ? null
                  : react.createElement('span', { style: { ...MUTED, fontSize: 11 } }, ' via'),
              ),
              String(link.edges),
              react.createElement('span', { style: { ...MUTED, fontSize: 12 } }, link.description || ''),
            ]),
          }),
        ),

        warnings.length > 0
          ? react.createElement(
              Section,
              { title: 'Warnings', note: warnings.length + '' },
              react.createElement(
                'ul',
                { style: { margin: 0, paddingLeft: 18, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.8 } },
                warnings.map((warning, index) => react.createElement('li', { key: index }, warning)),
              ),
            )
          : react.createElement(
              Section,
              { title: 'Warnings', note: 'none' },
              react.createElement(
                'p',
                { style: { ...MUTED, fontSize: 12.5, margin: 0 } },
                'The domain loaded cleanly and every declaration was usable.',
              ),
            ),
      )
    }

    /**
     * The Ontology page.
     *
     * The role box is applied on demand rather than on each keystroke: a fetch per
     * character would be noise, and asking a question on purpose is the point.
     */
    function OntologyPage() {
      const [state, setState] = react.useState({ status: 'loading' })
      const [roles, setRoles] = react.useState('')
      const [applied, setApplied] = react.useState('')

      react.useEffect(() => {
        let cancelled = false
        setState({ status: 'loading' })
        const query = applied.length > 0 ? '?roles=' + encodeURIComponent(applied) : ''
        fetch(DOMAIN_URL + query)
          .then(async (response) => {
            // Read the body as text first. Parsing straight to JSON throws away the
            // response on the one occasion it matters — when something is wrong — and
            // "Unexpected end of JSON input" names neither the status nor the body.
            const text = await response.text()
            if (cancelled) return
            if (text.length === 0) {
              setState({
                status: 'error',
                message: `the endpoint answered ${response.status} with an empty body`,
              })
              return
            }
            let body
            try {
              body = JSON.parse(text)
            } catch (error) {
              setState({
                status: 'error',
                message: `the endpoint answered ${response.status} with something that is not JSON (${String(error)}): ${text.slice(0, 200)}`,
              })
              return
            }
            if (!response.ok) setState({ status: 'error', message: body.error || response.statusText })
            else setState({ status: 'ready', data: body })
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'error', message: String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [applied])

      const controls = react.createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 } },
        react.createElement(
          'span',
          { style: { ...MUTED, fontSize: 11, letterSpacing: '.4px', textTransform: 'uppercase' } },
          'roles',
        ),
        react.createElement('input', {
          value: roles,
          onChange: (event) => setRoles(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') setApplied(roles.trim())
          },
          placeholder: '[{"prefix":"session-","role":"delivery-lead"}]',
          spellCheck: false,
          style: {
            flex: '0 1 420px',
            padding: '5px 8px',
            fontFamily: MONO,
            fontSize: 11.5,
            color: 'inherit',
            background: 'transparent',
            border: LINE,
            borderRadius: 6,
          },
        }),
        react.createElement(
          'button',
          {
            onClick: () => setApplied(roles.trim()),
            style: {
              padding: '5px 12px',
              fontSize: 12,
              color: 'inherit',
              background: WASH,
              border: LINE,
              borderRadius: 6,
              cursor: 'pointer',
            },
          },
          'Apply',
        ),
      )

      let body
      if (state.status === 'loading') {
        body = react.createElement('p', { style: { ...MUTED, fontSize: 12.5 } }, 'reading the domain…')
      } else if (state.status === 'error') {
        // An error from the engine is shown, not swallowed: a schema that cannot be read
        // throws by design, and hiding that would defeat the reason it throws.
        body = react.createElement(
          'p',
          { style: { fontSize: 12.5, fontFamily: MONO } },
          'Engine refused: ' + state.message,
        )
      } else {
        body = react.createElement(Domain, { data: state.data })
      }

      return react.createElement(
        'div',
        { style: { padding: '22px 26px 60px', maxWidth: 1020 } },
        react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12.5, margin: 0 } },
          'What the engine derived from this domain: the tools the agent would be given, ' +
            'and the permissions gating them.',
        ),
        controls,
        body,
      )
    }

    /** The nav row's icon. `sidebar.panellist` owner props are `{ size, active }`. */
    function OntologyIcon(props) {
      const size = props.size || 18
      const stroke = 'currentColor'
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        react.createElement('circle', { cx: 12, cy: 5, r: 2.2 }),
        react.createElement('circle', { cx: 5, cy: 19, r: 2.2 }),
        react.createElement('circle', { cx: 19, cy: 19, r: 2.2 }),
        react.createElement('path', { d: 'M12 7.2v4.3M12 11.5 6.3 16.9M12 11.5l5.7 5.4' }),
      )
    }

    /** The product name, for the shell's brand-name slot. */
    function BrandName() {
      return react.createElement(
        'span',
        { style: { fontWeight: 600, letterSpacing: '-0.2px' } },
        'DeepWork',
      )
    }

    /**
     * Which services this plugin needs before it activates.
     *
     * `inject` is informational for a client plugin; the registrations below are what
     * actually wait, each through `ctx.slots.inject`.
     */
    exports.inject = ['slots']

    /**
     * Register the page, its nav row, and the product name.
     *
     * Everything goes through `ctx.slots.inject` so activation order does not matter:
     * the parent slot may not be declared yet when this plugin starts.
     *
     * The shipped mark is deliberately left alone. It is the product's own identity, and
     * taking it over is a different act from renaming it — one that was not asked for and
     * was reverted once. Only the *name* is claimed, and only through the slot that
     * carries a name.
     */
    exports.apply = function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, OntologyPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 0, label: () => 'Ontology' },
          OntologyIcon,
        ),
      )

      // `priority` is the shadowing rank and the lowest renders, so -1 wins over the
      // shipped registration's default 0; equal ranks throw rather than pick silently.
      ctx.slots.inject('sidebar.brand.name', () =>
        ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, BrandName),
      )

      // The window title comes from `DSH_CLIENT_TITLE`, baked into DSH's own frontend
      // bundle at build time, and the shell rewrites the title on every session change.
      // A one-shot assignment therefore loses the race — which is how this was found,
      // and why the title is observed rather than set. Only the exact product string is
      // replaced, so a session title in front of it is left intact. Rewriting the title
      // fires the observer again, finds nothing to replace, and stops there.
      const rewriteTitle = () => {
        if (document.title.includes(PRODUCT_TITLE_FROM)) {
          document.title = document.title.split(PRODUCT_TITLE_FROM).join(PRODUCT_NAME)
        }
      }
      rewriteTitle()
      const titleObserver = new MutationObserver(rewriteTitle)
      titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    }

    return module.exports
  },
})
