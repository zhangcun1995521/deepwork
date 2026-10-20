/**
 * DeepWork external plugin — browser half.
 *
 * It answers, for one deployment: what can be reached, who may call it, and how the last attempt
 * ended. Read from the plugin's own host half at `/connectors` — one process, one origin, no second
 * server and no RPC layer. The host already holds the domain and the trail, so it is the only thing
 * that has the data, and a second copy of it would be a second answer.
 *
 * Hand-written rather than bundled, for the reason the ontology client records: DSH's client preset
 * resolves packages by globbing `packages/* .../package.json` inside the DSH repository and throws
 * for anything laid out otherwise, so an outside package has to produce the artifact itself. The
 * contract is small — a CJS body wrapped in `window.__ModuleLoader__.load({ id, factory })`, with
 * `id` equal to this package's name because the runtime asserts registration under it — and
 * `exports["./client"]` may name any relative path, so no build step is needed.
 *
 * **What the page never shows.** Not the address, even though the domain holds it: an address may
 * carry a token in its query string, and a page served over HTTP is a worse place for that than the
 * trail that refused to record it either. Not the credential either — only the *name* it is filed
 * under, which is what the domain declares and what an operator has to look up. Those absences are
 * deliberate, and the columns say "filled" or "empty" rather than anything more precise.
 *
 * **What the page does not do.** There is no probe button. Reaching a system is an approval-gated
 * agent act, and a page has no agent identity to ask on behalf of: a probe fired from here would
 * either be refused by this deployment's own gate or be the one path around it. The `note` line the
 * host sends says who to ask instead.
 *
 * Styling is relative: borders and fills derive from `currentColor`, and the one semantic colour is
 * a theme alias rather than a literal, so the panel follows whichever theme DSH is wearing instead
 * of imposing a palette that looks broken in half the themes it can be installed into.
 */
window.__ModuleLoader__.load({
  id: '@zhangcun123/external',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    /**
     * Shared by the nav row and the page; also the `main` slot key.
     *
     * Distinct from the ontology panel's id on purpose: two plugins registering one key would
     * replace each other's page, and this is a second view of the same deployment rather than a
     * second copy of the first.
     */
    const PANEL_ID = 'deepwork-connectors'

    /**
     * Where the host half serves this view.
     *
     * Relative and same-origin, with the session cookie, because that is the door the shell itself
     * knocked on: a token in the query string would end up in histories and logs, and the host
     * already has the caller's identity from the request. The snapshot is built per request, so a
     * reload is the only way to see a call that happened since the page opened.
     */
    const CONNECTORS_URL = '/connectors'

    /**
     * Where one page-initiated call goes.
     *
     * A `POST` to the host half, which resolves the same route the tool would resolve and reads the
     * same `tool_grants`. The page deliberately does not pre-check the grant itself: a second copy of
     * that rule is a second answer, and the host's is the one the guard answers with. What the page
     * shows when the host refuses is the host's own reason.
     */
    const REACH_URL = '/connectors/reach'
    // Borders and fills derive from whatever colour the shell is painting with, so the page follows
    // the theme instead of pinning a palette. `DANGER` is the one semantic colour: it resolves to a
    // theme alias, with `currentColor` as the fallback for a shell that ships no such token — a
    // literal here would be the thing that looks wrong in the other theme.
    const LINE = '1px solid color-mix(in srgb, currentColor 18%, transparent)'
    const HAIRLINE = '1px solid color-mix(in srgb, currentColor 10%, transparent)'
    const WASH = 'color-mix(in srgb, currentColor 4%, transparent)'
    const MUTED = { opacity: 0.65 }
    const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace'
    const DANGER = 'var(--dsw-alias-state-error-primary, currentColor)'
    const DANGER_WASH =
      'color-mix(in srgb, var(--dsw-alias-state-error-primary, currentColor) 7%, transparent)'

    /** Section with a small heading. */
    function Section(props) {
      return react.createElement(
        'section',
        { style: { marginTop: 24 } },
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

    /**
     * A dense table whose rows may carry a second, spanning line.
     *
     * The spanning line exists because a route's problems are sentences, not cells: nine routes
     * fit beside seven columns, and the reason a call would be refused does not. Putting the
     * sentences under the row they belong to keeps them readable without a second table that the
     * reader has to join by hand.
     */
    function Table(props) {
      const cell = { padding: '6px 14px 6px 0', verticalAlign: 'top', fontSize: 12.5 }
      const body = []
      props.rows.forEach((row, index) => {
        body.push(
          react.createElement(
            'tr',
            {
              key: 'row-' + index,
              style: {
                borderTop: index === 0 ? 'none' : HAIRLINE,
                background: row.danger ? DANGER_WASH : 'transparent',
              },
            },
            row.cells.map((value, column) =>
              react.createElement('td', { key: column, style: cell }, value),
            ),
          ),
        )
        if (row.detail !== null && row.detail !== undefined) {
          body.push(
            react.createElement(
              'tr',
              { key: 'detail-' + index, style: { background: DANGER_WASH } },
              react.createElement(
                'td',
                { colSpan: props.headers.length, style: { padding: '0 14px 9px 0' } },
                row.detail,
              ),
            ),
          )
        }
      })
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
        react.createElement('tbody', null, body),
      )
    }

    /** Monospace text, used for identifiers and field names. */
    function Code(props) {
      return react.createElement(
        'span',
        { style: { fontFamily: MONO, fontSize: 12, ...(props.muted ? MUTED : {}) } },
        props.children,
      )
    }

    /** A small uppercase label in front of a value. */
    function Labeled(props) {
      return react.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'baseline', gap: 6 } },
        react.createElement(
          'span',
          { style: { ...MUTED, fontSize: 10.5, letterSpacing: '.4px', textTransform: 'uppercase' } },
          props.label,
        ),
        props.children,
      )
    }

    /** One headline number. `danger` is for a count whose being zero is the finding. */
    function Counter(props) {
      return react.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'baseline', gap: 6 } },
        react.createElement(
          'b',
          {
            style: {
              fontFamily: MONO,
              fontSize: 16,
              fontWeight: 600,
              ...(props.danger ? { color: DANGER } : {}),
            },
          },
          String(props.value),
        ),
        react.createElement(
          'span',
          { style: { ...MUTED, fontSize: 10.5, letterSpacing: '.4px', textTransform: 'uppercase' } },
          props.label,
        ),
      )
    }

    /**
     * Problems that belong to the deployment rather than to one route.
     *
     * They are shown above the table because they change how every row below should be read. A
     * grant that does not exist is one broken configuration, not nine broken routes, and putting it
     * in the rows would make it look like the latter.
     */
    function Findings(props) {
      if (props.findings.length === 0) {
        return react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12.5, margin: 0 } },
          'No deployment-level problems: each route below is judged on its own declaration.',
        )
      }
      return react.createElement(
        'div',
        { style: { borderLeft: '2px solid ' + DANGER, paddingLeft: 10 } },
        props.findings.map((finding, index) =>
          react.createElement(
            'div',
            {
              key: index,
              style: { fontSize: 12.5, color: DANGER, lineHeight: 1.65, marginTop: index === 0 ? 0 : 6 },
            },
            react.createElement('code', { style: { fontFamily: MONO, fontSize: 11 } }, finding.code),
            ' — ' + finding.detail,
          ),
        ),
      )
    }

    /** One route's own problems, shown under that route's row. */
    function ProblemList(props) {
      return react.createElement(
        'div',
        { style: { color: DANGER, fontSize: 11.5, lineHeight: 1.6 } },
        props.problems.map((problem, index) =>
          react.createElement(
            'div',
            { key: index },
            react.createElement('code', { style: { fontFamily: MONO, fontSize: 11 } }, problem.code),
            ' — ' + problem.detail,
          ),
        ),
      )
    }

    /**
     * Whether the route's address field holds anything.
     *
     * The value itself is never rendered, here or anywhere else on the page: an address may carry a
     * token in its query string, and "filled" answers the only question a reader of this page has.
     */
    function AddressCell(props) {
      return react.createElement(
        'span',
        null,
        react.createElement(Code, { muted: true }, props.address.field),
        react.createElement(
          'span',
          {
            style: {
              fontSize: 11.5,
              ...(props.address.set ? MUTED : { color: DANGER }),
            },
          },
          props.address.set ? ' filled' : ' empty',
        ),
      )
    }

    /**
     * The name the credential is filed under, never the credential.
     *
     * `addressable: false` means the seam's grammar cannot address that name, which is a fact about
     * the reference rather than about the secret — and a route whose name is blank has nothing to
     * be addressable or not, so it gets one line instead of two.
     */
    function CredentialCell(props) {
      const credential = props.credential
      const named = credential.name.length > 0
      return react.createElement(
        'span',
        null,
        react.createElement(Code, { muted: true }, credential.field),
        named
          ? react.createElement(Code, null, credential.name)
          : react.createElement('span', { style: { fontSize: 11.5, ...MUTED } }, ' empty'),
        named && !credential.addressable
          ? react.createElement(
              'span',
              { style: { fontSize: 11.5, color: DANGER } },
              ' not addressable',
            )
          : null,
      )
    }

    /**
     * Who may call this route, read the way the guard reads it.
     *
     * The program grant is required, so its absence means nobody — not unrestricted. The tool grant
     * only narrows, so an absent entry changes nothing and only an empty list is worth saying.
     */
    function CallersCell(props) {
      const callers = props.callers
      const programRoles = callers.programRoles
      const toolRoles = callers.toolRoles
      const program =
        programRoles === null
          ? react.createElement(
              'span',
              { style: { color: DANGER } },
              'nobody — no grant for ' + callers.program,
            )
          : programRoles.length === 0
            ? react.createElement(
                'span',
                { style: { color: DANGER } },
                'nobody — granted to no role',
              )
            : react.createElement(Code, null, programRoles.join(', '))
      const tool =
        toolRoles === null
          ? null
          : toolRoles.length === 0
            ? react.createElement(
                'span',
                { style: { fontSize: 11.5, color: DANGER } },
                ' · reach_system: nobody',
              )
            : react.createElement(
                'span',
                { style: { fontSize: 11.5, ...MUTED } },
                ' · reach_system: ' + toolRoles.join(', '),
              )
      return react.createElement('span', { style: { fontSize: 12 } }, program, tool)
    }

    /**
     * The last attempt, if there was one.
     *
     * "Never called" is not "refused": a fresh deployment has no trail at all, and showing that as
     * a refusal would blame a route for not having been tried. `outcome: 'allowed'` is likewise
     * about the gate, not about the far side — the details say whether it answered.
     */
    function LastCell(props) {
      const last = props.last
      if (last === null) {
        return react.createElement('span', { style: { fontSize: 12, ...MUTED } }, 'never called')
      }
      const details = []
      if (last.timedOut === true) details.push('timed out')
      if (last.reachable === false) details.push('far side unreachable')
      if (last.exitCode !== undefined) {
        details.push(last.exitCode === null ? 'no exit code' : 'exit ' + last.exitCode)
      }
      if (last.elapsedMs !== undefined) details.push(last.elapsedMs + ' ms')
      if (last.reason !== undefined) details.push(last.reason)
      return react.createElement(
        'span',
        { style: { fontSize: 12 } },
        react.createElement(
          'b',
          {
            style: {
              fontWeight: 600,
              ...(last.outcome === 'denied' ? { color: DANGER } : {}),
            },
          },
          last.outcome,
        ),
        react.createElement('span', { style: { ...MUTED, fontFamily: MONO, fontSize: 11 } }, ' ' + last.at),
        details.length === 0
          ? null
          : react.createElement(
              'div',
              { style: { ...MUTED, fontSize: 11.5, marginTop: 2 } },
              details.join(' · '),
            ),
        props.refusals === 0
          ? null
          : react.createElement(
              'div',
              { style: { fontSize: 11.5, color: DANGER, marginTop: 2 } },
              props.refusals + (props.refusals === 1 ? ' refusal' : ' refusals') + ' in the trail',
            ),
      )
    }

    /**
     * The route's state, and whether anything is against calling it.
     *
     * A type with no lifecycle has no state to report, which is a different answer from a route
     * sitting in a state a call will not dial — so the two do not share a word.
     */
    function StateCell(props) {
      const dialable = props.dialable
      // "in X → needs X" would be noise: the required state is only worth naming when the route is
      // not in it, which is exactly the case `ok` already flags.
      const state =
        dialable.required !== null && !dialable.ok
          ? react.createElement(
              'span',
              { style: { fontSize: 12 } },
              react.createElement(Code, null, dialable.state.length > 0 ? dialable.state : 'unset'),
              react.createElement('span', { style: { ...MUTED } }, ' → needs '),
              react.createElement(Code, null, dialable.required),
            )
          : dialable.state.length > 0
            ? react.createElement(Code, null, dialable.state)
            : react.createElement('span', { style: { fontSize: 12, ...MUTED } }, 'no lifecycle')
      return react.createElement(
        'span',
        null,
        state,
        react.createElement(
          'div',
          {
            style: {
              fontSize: 11.5,
              marginTop: 2,
              ...(props.problems.length === 0 ? MUTED : { color: DANGER }),
            },
          },
          props.problems.length === 0
            ? 'complete'
            : props.problems.length + (props.problems.length === 1 ? ' problem' : ' problems'),
        ),
      )
    }

    /** One row per route. */
    function ConnectorsTable(props) {
      if (props.connectors.length === 0) {
        return react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12.5 } },
          'This deployment declares no route.',
        )
      }
      const headers = [
        'route',
        'system',
        'address',
        'credential',
        'who may call',
        'last attempt',
        'state',
        'try it',
      ]
      const rows = props.connectors.map((connector) => ({
        danger: connector.problems.length > 0,
        detail:
          connector.problems.length === 0
            ? null
            : react.createElement(ProblemList, { problems: connector.problems }),
        cells: [
          react.createElement(Code, null, connector.id),
          connector.system === null
            ? react.createElement('span', { style: { fontSize: 12, ...MUTED } }, 'not named')
            : react.createElement('span', { style: { fontSize: 12.5 } }, connector.system),
          react.createElement(AddressCell, { address: connector.address }),
          react.createElement(CredentialCell, { credential: connector.credential }),
          react.createElement(CallersCell, { callers: connector.callers }),
          react.createElement(LastCell, { last: connector.last, refusals: connector.refusals }),
          react.createElement(StateCell, {
            dialable: connector.dialable,
            problems: connector.problems,
          }),
          react.createElement(ReachCell, {
            id: connector.id,
            outcome: props.outcomes[connector.id],
            onReach: props.onReach,
          }),
        ],
      }))
      // A table wider than the column is normal for this many columns; the box scrolls sideways
      // instead of squeezing the text into unreadable slivers.
      return react.createElement(
        'div',
        { style: { overflow: 'auto' } },
        react.createElement(Table, { headers: headers, rows: rows }),
      )
    }

    /**
     * The reach column: one button, and whatever came back.
     *
     * Enabled for every row on purpose, including the ones the page already knows are blocked. The
     * grant lives in the domain and is checked by the host; a button that refused to be pressed would
     * be a second copy of that rule, and the copy that disagrees is always the one a reader believes.
     * So the button asks, the host answers, and the answer is shown as it came — with a code, because
     * "not-in-default-state" is something a reader can act on and a paragraph is not.
     */
    function ReachCell(props) {
      const outcome = props.outcome
      const button = react.createElement(
        'button',
        {
          onClick: () => props.onReach(props.id),
          disabled: outcome !== undefined && outcome.status === 'running',
          style: {
            padding: '3px 10px',
            fontSize: 11.5,
            color: 'inherit',
            background: WASH,
            border: LINE,
            borderRadius: 5,
            cursor: outcome !== undefined && outcome.status === 'running' ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        outcome !== undefined && outcome.status === 'running' ? 'reaching…' : 'Reach',
      )

      if (outcome === undefined) return button

      if (outcome.status === 'running') {
        return react.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          button,
          react.createElement('span', { style: { fontSize: 11, ...MUTED } }, 'dialling…'),
        )
      }

      // A refusal is the interesting half: it names the check that stopped the call, and it is the
      // reason a reader opened this page at all.
      const refused = outcome.status === 'refused' || outcome.status === 'failed'
      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 } },
        button,
        react.createElement(
          'span',
          {
            style: {
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: MONO,
              color: refused ? DANGER : 'inherit',
              ...(refused ? {} : MUTED),
              wordBreak: 'break-word',
            },
          },
          refused
            ? outcome.code + ' — ' + outcome.text
            : 'exit ' +
              String(outcome.exitCode) +
              ' · ' +
              (outcome.reachable ? 'reachable' : 'not reachable') +
              ' · ' +
              outcome.elapsedMs +
              'ms' +
              (outcome.output === undefined ? '' : ' · ' + outcome.output.slice(0, 160)),
        ),
      )
    }

    /** Route type, program, and the three counts a reader compares first. */
    function Identity(props) {
      const data = props.data
      return react.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '7px 26px', marginTop: 10 } },
        react.createElement(
          Labeled,
          { label: 'route type' },
          react.createElement(Code, null, data.routeType),
        ),
        react.createElement(Labeled, { label: 'program' }, react.createElement(Code, null, data.program)),
        react.createElement(Counter, { label: 'routes', value: data.summary.routes }),
        react.createElement(Counter, { label: 'complete', value: data.summary.complete }),
        react.createElement(Counter, {
          label: 'callable',
          value: data.summary.callable,
          danger: data.summary.callable === 0,
        }),
      )
    }

    /** Everything the page shows once the snapshot has arrived. */
    function Snapshot(props) {
      const data = props.data
      const open = data.connectors.length
      return react.createElement(
        'div',
        null,
        react.createElement(
          'code',
          { style: { fontFamily: MONO, fontSize: 11.5, ...MUTED } },
          data.root,
        ),
        react.createElement(Identity, { data: data }),
        // The two counts are not the same question, so the page says which is which rather than
        // leaving a reader to wonder why nine complete routes are none callable.
        react.createElement(
          'p',
          { style: { fontSize: 11.5, ...MUTED, margin: '5px 0 0' } },
          'complete counts routes whose own declaration is clean; callable also weighs this ' +
            "deployment's grants, so the two differ when a deployment finding applies.",
        ),
        react.createElement(
          'p',
          {
            style: {
              fontSize: 12,
              margin: '12px 0 0',
              padding: '7px 10px',
              border: HAIRLINE,
              borderRadius: 6,
              background: WASH,
              ...MUTED,
            },
          },
          data.note,
        ),
        react.createElement(
          Section,
          {
            title: 'Deployment findings',
            note:
              data.findings.length === 0
                ? 'none'
                : data.findings.length + ' — these affect every route below',
          },
          react.createElement(Findings, { findings: data.findings }),
        ),
        react.createElement(
          Section,
          {
            title: 'Connectors',
            note: open + (open === 1 ? ' route' : ' routes'),
          },
          data.readable
            ? react.createElement(ConnectorsTable, {
                connectors: data.connectors,
                outcomes: props.outcomes,
                onReach: props.onReach,
              })
            : react.createElement(
                'p',
                { style: { fontSize: 12.5, color: DANGER } },
                'The domain could not be read, so there are no routes to show; the finding above ' +
                  'says why.',
              ),
        ),
      )
    }

    /**
     * The Connectors page.
     *
     * Refreshed on demand rather than on a timer: this is a view of declarations and of a trail
     * that only grows when an agent acts, so a silent poll would spend requests to show the same
     * page — and a reader who wants the current answer can ask for it.
     */
    function ConnectorsPage() {
      const [state, setState] = react.useState({ status: 'loading' })
      const [reloads, setReloads] = react.useState(0)
      // One outcome per route, so a slow system does not blank the rest of the table and a reader can
      // see which rows they already tried.
      const [outcomes, setOutcomes] = react.useState({})

      const setOutcome = (id, outcome) =>
        setOutcomes((current) => ({ ...current, [id]: outcome }))

      /**
       * Dial one route through the host half.
       *
       * The snapshot is re-read when the call is over, because the trail just grew: `last attempt` is
       * read from it, and a page that kept the old answer would show a call it had itself made.
       */
      const dial = (id) => {
        setOutcome(id, { status: 'running' })
        fetch(REACH_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ route_id: id }),
        })
          .then(async (response) => {
            const text = await response.text()
            let body
            try {
              body = text.length === 0 ? null : JSON.parse(text)
            } catch {
              setOutcome(id, {
                status: 'failed',
                code: 'not-json',
                text: 'HTTP ' + response.status + ': ' + text.slice(0, 200),
              })
              return
            }
            if (!response.ok) {
              setOutcome(id, {
                status: 'refused',
                code: (body && body.code) || 'HTTP ' + response.status,
                text: (body && body.error) || response.statusText || 'refused',
              })
              return
            }
            setOutcome(id, {
              status: 'reached',
              exitCode: body.exitCode,
              reachable: body.reachable,
              elapsedMs: body.elapsedMs,
              output: body.output,
            })
          })
          .catch((error) => {
            setOutcome(id, { status: 'failed', code: 'request-failed', text: String(error) })
          })
          .finally(() => setReloads((current) => current + 1))
      }

      react.useEffect(() => {
        let cancelled = false
        setState({ status: 'loading' })
        fetch(CONNECTORS_URL, { credentials: 'same-origin' })
          .then(async (response) => {
            // Read the body as text first. Parsing straight to JSON throws away the response on
            // the one occasion it matters — when something is wrong — and "Unexpected end of JSON
            // input" names neither the status nor the body.
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
            if (!response.ok) {
              setState({
                status: 'error',
                message:
                  (body.error || response.statusText || 'HTTP ' + response.status) +
                  ` (HTTP ${response.status})`,
              })
              return
            }
            setState({ status: 'ready', data: body })
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'error', message: String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [reloads])

      const heading = react.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
        react.createElement(
          'p',
          { style: { ...MUTED, fontSize: 12.5, margin: 0, flex: '1 1 auto' } },
          'What this deployment can reach, who may call it, and how the last attempt ended. Read ' +
            'from declarations and from this plugin’s own trail.',
        ),
        react.createElement(
          'button',
          {
            onClick: () => setReloads((current) => current + 1),
            style: {
              flex: 'none',
              padding: '5px 12px',
              fontSize: 12,
              color: 'inherit',
              background: WASH,
              border: LINE,
              borderRadius: 6,
              cursor: 'pointer',
            },
          },
          'Refresh',
        ),
      )

      let body
      if (state.status === 'loading') {
        body = react.createElement('p', { style: { ...MUTED, fontSize: 12.5 } }, 'reading the connectors…')
      } else if (state.status === 'error') {
        // Shown, not swallowed: the commonest failure here is a profile that never served this
        // route, and a blank panel would hide exactly that.
        body = react.createElement(
          'p',
          { style: { fontSize: 12.5, fontFamily: MONO, color: DANGER } },
          'Could not read ' + CONNECTORS_URL + ': ' + state.message,
        )
      } else {
        body = react.createElement(Snapshot, {
          data: state.data,
          outcomes: outcomes,
          onReach: dial,
        })
      }

      // `main` is a clipped column, so the page owns its own scrolling — the shape the shipped
      // panels use: a full-height box that scrolls, with the content constrained inside it. Without
      // `height` and `overflow` the content is simply cut off, which is how the ontology panel
      // found the same thing.
      return react.createElement(
        'div',
        {
          'data-deepwork-page': '',
          style: {
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'auto',
            padding: '22px 26px 60px',
          },
        },
        react.createElement('div', { style: { maxWidth: 1080 } }, heading, body),
      )
    }

    /**
     * The nav row's icon. `sidebar.panellist` owner props are `{ size, active }`.
     *
     * A plug: two prongs, a body, a cord. It reads as "something joins something else" at 18px,
     * which is what this panel is about.
     */
    function ConnectorsIcon(props) {
      const size = props.size || 18
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        react.createElement('path', { d: 'M9 2.8v4M15 2.8v4' }),
        react.createElement('path', { d: 'M6.4 6.8h11.2v3.4a5.6 5.6 0 0 1-11.2 0V6.8Z' }),
        react.createElement('path', { d: 'M12 15.8v5.4' }),
      )
    }

    /**
     * Which services this plugin needs before it activates.
     *
     * `inject` is informational for a client plugin; the registrations below are what actually
     * wait, each through `ctx.slots.inject`.
     */
    exports.inject = ['slots']

    /**
     * Register the page and its nav row.
     *
     * Everything goes through `ctx.slots.inject` so activation order does not matter: the parent
     * slot may not be declared yet when this plugin starts. `order: 1` puts this row below the
     * ontology panel's, which is the same deployment seen from the other side. Nothing else is
     * claimed here — in particular the product's name is not, because naming the product is the
     * ontology panel's act and not this one's.
     */
    exports.apply = function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, ConnectorsPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: () => 'Connectors' },
          ConnectorsIcon,
        ),
      )
    }

    return module.exports
  },
})
