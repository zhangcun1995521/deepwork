# @zhangcun123/computer

## Install

```sh
dsh plugin --profile web add @zhangcun123/computer
```

Then add `@zhangcun123/computer` to `dsh.profile.bundles` in the profile's `package.json` (the plugin manager does
both steps). Requires DeepSeek Harness `0.1.7-rc.2` and up within the `0.1` line: the manifest declares
that range as a peer dependency, and the harness refuses a plugin built for a different runtime instead
of loading it into one — which is the failure this package would rather have.

> A DeepWork capability: look at this machine's windows, and act on them.

A **capability** in this platform's sense is one plugin that gives an agent an ability. Here the
ability is the desktop itself, on **two channels**:

- **the tree** — `list_windows` gives handles, `get_window_state` reads one window's elements each
  with a stable `index`, and `click`, `type_text` and `press_key` act on what was read there.
- **the picture** — `screenshot` returns an image, and `click_at` acts on a point in it.

Use the tree whenever it has an answer. It is cheaper, it names what a thing *is*, and `click`
re-checks before acting. Use the picture where the tree is silent — which includes the whole
desktop, whose icons are published to nothing at all and can only be reached by looking at it.

**Windows-only, and stated rather than wrapped.** `powershell.exe`, UIA and `SendInput` are the
machine this reaches. There is no non-Windows branch, because there is no other desktop here to
reach, and a tool that claimed otherwise would be lying about half its calls.

**All coordinates are physical pixels** — a window's rectangle, the picture of it, and the point
`click_at` takes are the same space. That matters on a scaled display (this one runs at 150%),
where a DPI-unaware process reads and writes 2/3 of the real number and a correct click looks like a
wrong one.

## The order, and why it is the design

```
① read      list_windows            → handles
② read      get_window_state        → elements, each with an index
③ act       click / type_text       → names the index *and* what it saw there
            press_key               → names the window
   or
① read      screenshot              → the picture, plus where the window sits and how pixels map
② act       click_at                → a screen coordinate, inside that window
```

`click` and `type_text` take the `control` and `name` the caller saw at that `index`, and the tool
**walks the tree again before acting**. If the element there is no longer that control with that
name, the call is refused rather than performed:

```
REFUSED (index-moved): index 7 is no longer 'Button'/'Save' — re-read the window and address it again
```

That is not ceremony. Between reading and clicking, a list can reorder and a dialog can close, and
`index 7` becomes a different button. A refused click costs a re-read; a wrong click costs whatever
it landed on, and clicking is not undoable by re-reading.

`click_at` cannot ask that question — it names a point, not an element — so it checks the only thing
it can: that the point lies inside the window the caller named. A point outside it is refused rather
than clicked onto whatever has moved over it. It is the blind verb, and the manual tells the caller
to take another screenshot afterwards, because it is the one verb that cannot say whether it hit
what was meant.

`type_text` prefers the accessibility action of the field it names; `click` prefers the control's own
`InvokePattern` and falls back to a real pointer at its centre. Typing is preferred to a sequence of
clicks for the same reason: reaching a value by typing has an undo.

## Configuration

```yaml
applications:     # window titles this deployment will speak to, matched as a substring
requireApproval:  # whether the first act in a session asks a user; defaults to true
```

Empty means the deployment named none, and every window is addressable. That permissive default is
written down here rather than left to be discovered, because it is a real choice: name the
applications you expect an agent to touch. A window that is not named is refused before anything is
touched — including a `screenshot`, which leaks a forbidden window as surely as a click changes it.

**The approval is the capability's, asked once per session.** The first of the four verbs that
change the machine stops and asks, the question names the windows the answer covers, and a yes opens
the desktop for that agent until the session ends — every later act runs without asking again. The
alternative was measured by trying it: a question per click makes a ten-step task ten questions, and
a confirmation nobody reads only teaches the person answering it to click through. The three verbs
that only look never ask, which is what makes *read the window, then act* a workflow rather than a
prompt.

The gate is a strict one: only the host's explicit `'allowed-once'` opens it, and *every* other
ending refuses and leaves it shut — declined, withdrawn, no answerer (the host's fail-closed
`'unavailable'`), no approval service mounted, or a question that threw. A refusal is **text the
model reads, not an exception**, and it names which of them it was, so an act that was refused can
be explained rather than mistaken for a broken tool. `requireApproval: false` removes the gate
entirely, which a deployment has to say deliberately.

## Governance — what is declared, and the limit that is stated

Every verb starts `powershell.exe`, so every verb **declares that program** to the guard and none is
a verb nothing judges. The deployment decides, in its domain's `tool_grants`, which roles may look
and which may act — a tool that declares a program and finds no grant for it is refused outright
("nobody said who may run this" is the worse answer to give an execution tool):

```yaml
tool_grants:
  powershell.exe: [viewer, operator]   # nobody runs PowerShell on this machine unless named here
  click: [operator]                    # looking is broad; touching is narrow
  click_at: [operator]
  type_text: [operator]
  press_key: [operator]
```

An entry under a verb's own name **narrows**; the program entry is the required half. So the four
lines above let a `viewer` read the desktop and refuse it the three verbs that change it. This is
the same mechanism [`examples/outside-systems`](../../ontology/examples/outside-systems) uses for a
tool that reaches out of the deployment, and it was not changed to suit this capability.

**The limit, said rather than papered over:** the guard judges a **verb and a role**, not *which
application*. "The agent may click, but only in the text editor" is not expressible through
`tool_grants`, and expressing it would be a new concept in the ontology — so it is not expressed
here. The `applications` setting narrows by window title at the plugin, which is deployment
configuration, not a governance declaration. Two different things, and this file does not pretend
they are one.

## Showing the picture, and when it cannot

`screenshot` puts the capture in front of the model through the host's **attachment** channel: the
PNG is stored with `attachments.saveImage`, and the tool result is two content blocks — the words,
then `{ type: 'image', attachment: <ref> }`. The text that comes with it is not decoration: it
carries the window's screen rectangle, the picture's own pixel size, and the exact arithmetic that
turns a pixel in the picture into the screen coordinate `click_at` wants. When the store hands back
a smaller picture than the window, the scale factor is stated — an unstated one is how a click lands
somewhere nobody pointed at.

Two conditions are asked before attaching, and both answer "no" rather than throwing when anything
is unknown, so a screenshot degrades to a file path instead of failing a request:

- the profile has to have mounted an image store (`attachments`), and
- **the model has to declare image input** — resolved from the session's route, the same question
  the host's own `read_image` asks. `deepseek-flash` declares `["text", "image"]`; `deepseek-v4-pro`
  declares `["text"]`, and on that route a capture comes back as words and a path.

The `text` says which of these happened, in the same reply. A caller that assumes it was shown a
picture it did not receive is acting on coordinates it made up.

## What it deliberately does not do

**It does not decide who may touch what, and it does not read the ontology.** It imports nothing from
the ontology package — a capability that knew what a `Customer` was would have to know the customer's
world. It says the one thing it knows, that it runs `powershell.exe`, and hands the decision to the
deployment.

## Verifying

```sh
npm test        # 30 tests: 23 at the mounting seam, and 7 that really run PowerShell
```

The mounting tests pin the failure this capability has now shipped twice: a `required` nested inside
a property makes the host reject the whole schema and `apply` goes down with it. It is checked on the
**output** schemas as well as the parameters, because the second time it happened exactly there — the
image result's schema carried `required: true` on every property, the raw registry answered
`unsupported JSON schema`, and a real profile refused to load the plugin while every test stayed
green. That is the same shape of miss `test-runner` recorded, and it is why the check now walks the
whole document rather than the top level.

The mounting tests also drive the **approval gate** end to end at the seam: the first act by an agent
asks once and the acts after it do not, a second agent is asked on its own first act, a call with no
agent id opens nothing, a refusal leaves the gate exactly where it was, the question carries the scope
it covers, a granted approval reaches PowerShell while a refused one never does, the three refusals
and the two ways of having nothing to ask each read differently, the service is looked up when the
verb runs rather than when the plugin mounts, and a deployment that switches the gate off is never
asked.

The script tests run `list-windows.ps1` for real, read a window's elements, and exercise the four
refusals reachable without touching anything — a handle that names no window, a window the
deployment did not name, an index whose element has moved, and a point outside the window it was
aimed at. One of them captures a single element to pin a silent failure the first draft shipped: a
screenshot that advertised an `index` and captured the whole window anyway.
Each refusal is one a caller must be able to read, and none of them is visible to a test that stops
at the registry.

**One thing has no test here, and it is worth knowing which.**

`type_text` is not covered, because there is no hermetic target to type into: Notepad on Windows 11
restores sessions and opens files as tabs, so "the window with my file in its title" is not reliably
"the buffer I am about to write to", and a form built for the purpose is not visible to this
project's accessibility walk at all.

What that investigation did settle is that **the mangling is not this capability's**. With no gap
between characters, Notepad turns `a bcd` into `a ddd`; a target that logs its own `WM_CHAR` receives
`a`, space, `b`, `c`, `d` — with the gap and without it. The characters leave here correct and the
editor is what collapses them, at word boundaries (space, `,` and `.` trigger it; `-` does not).
An input-method theory was tested and does not hold: switching the target window to en-US changes
nothing.

So `TEXT_GAP_MS` **tolerates** a target that cannot consume a burst rather than fixing anything,
and it costs one delay per character — a long string takes as long as the gap times its length.
Only Notepad has been shown to need it.

`press_key` is likewise checked only by hand, because it sends one event and reads nothing back —
the only thing a test could assert is that the call did not throw.
