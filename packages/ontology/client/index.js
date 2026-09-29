/**
 * DeepWork ontology plugin — browser half, hand-written.
 *
 * Why this file is hand-written rather than produced by a bundler: DSH's own client
 * preset (`packages/client/tsdown.client.ts`) is monorepo-bound — it resolves a package
 * by globbing `packages/* .../package.json` inside the DSH repository and throws for
 * anything laid out otherwise. So an outside package must produce the same artifact
 * itself. That artifact turns out to be small enough to write directly: the runtime
 * serves whatever `exports["./client"]` names, so no build step is needed at all.
 *
 * The wrapper is the load-bearing part, and it is exact: `__ModuleLoader__.load` is
 * asserted by the runtime — a bundle that fails to register under its own id is a hard
 * error, not a silent no-op. The `id` must be this package's name, because that is the
 * Loader row the client module registry resolved in order to serve this file.
 *
 * Inside, `require` is the module system's own: React and the shared UI primitives
 * arrive through it (they are platform externals), while everything else is inlined by
 * convention. Nothing here imports a sibling plugin's values; collaboration happens
 * through services on `ctx`.
 *
 * The panel pattern — one `sidebar.panellist` entry for the nav row plus one `main`
 * entry keyed by the same id — is the one DSH's own Plugins page uses. It needs no edit
 * to any shell package, which is why this is a plugin and not a fork.
 */
window.__ModuleLoader__.load({
  id: '@zhangcun123/ontology',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    /** Panel id shared by the nav row and the page; also the `main` slot key. */
    const PANEL_ID = 'deepwork-ontology'

    const COLOURS = {
      bg: '#0e1116',
      panel: '#161b22',
      line: '#2a323d',
      fg: '#d8dee9',
      dim: '#8b98a8',
      accent: '#6ba3ff',
    }

    /**
     * The nav row's icon.
     *
     * `sidebar.panellist` is a list slot and its owner props are `{ size, active }`, so
     * the icon is drawn from those rather than from plugin state.
     */
    function OntologyIcon(props) {
      const size = props.size ?? 18
      const stroke = props.active ? COLOURS.accent : 'currentColor'
      return react.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        react.createElement('circle', { cx: 12, cy: 5, r: 2.4, stroke, strokeWidth: 1.6 }),
        react.createElement('circle', { cx: 5, cy: 19, r: 2.4, stroke, strokeWidth: 1.6 }),
        react.createElement('circle', { cx: 19, cy: 19, r: 2.4, stroke, strokeWidth: 1.6 }),
        react.createElement('path', {
          d: 'M12 7.4v4.1M12 11.5 6.4 16.9M12 11.5l5.6 5.4',
          stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /** Section heading used inside the page. */
    function Section(props) {
      return react.createElement(
        'section',
        { style: { marginBottom: 22 } },
        react.createElement(
          'h2',
          {
            style: {
              margin: '0 0 8px',
              fontSize: 12,
              letterSpacing: '.7px',
              textTransform: 'uppercase',
              color: COLOURS.dim,
              fontWeight: 500,
            },
          },
          props.title,
        ),
        props.children,
      )
    }

    /** A row of monospace identifiers. */
    function Chips(props) {
      return react.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        props.items.map((item) =>
          react.createElement(
            'code',
            {
              key: item,
              style: {
                font: '12px/1.6 ui-monospace, Consolas, monospace',
                padding: '3px 8px',
                borderRadius: 6,
                border: `1px solid ${COLOURS.line}`,
                background: COLOURS.panel,
              },
            },
            item,
          ),
        ),
      )
    }

    /**
     * The Ontology page.
     *
     * This first version states what the panel is and what the tools are. It is a
     * placeholder in the honest sense: the mechanism is what is being proven here, and
     * the data arrives in the next step, over a Remote from the host half — which
     * already holds the loaded graph.
     */
    function OntologyPage() {
      return react.createElement(
        'div',
        { style: { padding: '28px 32px', maxWidth: 880, color: COLOURS.fg } },
        react.createElement(
          'p',
          { style: { color: COLOURS.dim, margin: '0 0 24px', fontSize: 13 } },
          'The enterprise layer this plugin adds to DSH: an ontology the domain declares, ' +
            'and the tool surface and permissions derived from it.',
        ),
        react.createElement(
          Section,
          { title: 'Tools derived from the domain' },
          react.createElement(Chips, {
            items: ['ontology_get', 'ontology_find', 'ontology_links', 'ontology_query', 'ontology_write'],
          }),
        ),
        react.createElement(
          Section,
          { title: 'Not yet wired' },
          react.createElement(
            'p',
            { style: { color: COLOURS.dim, fontSize: 13, margin: 0 } },
            'This panel is the proof that an outside package can add a page and a nav row ' +
              'without forking DSH. The domain data — entities, relations, the derived ' +
              'schemas, who may write what — comes next, read from the host half over a ' +
              'Remote rather than from a second server.',
          ),
        ),
      )
    }

    /** Which services this plugin needs before it activates. */
    exports.inject = ['slots']

    /**
     * Client plugin body.
     *
     * Both registrations go through `ctx.slots.inject` so that activation order does
     * not matter: the parent slot may not be declared yet when this plugin starts.
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
    }

    return module.exports
  },
})
