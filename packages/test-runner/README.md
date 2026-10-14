# @zhangcun123/test-runner

> A DeepWork capability: run a project's tests, and read what the run said.

A **capability** in this platform's sense is one plugin that gives an agent an ability — here,
running a test suite and understanding the result. It registers two tools, because those are two
halves of one thing: running without reading tells you nothing.

`run_tests` runs the configured command in the configured workspace and then parses the junit
report it wrote. `parse_junit` reads a report that already exists, without running anything.

## Configuration

```yaml
workspace:      # where the tests live; empty means the plugin registers nothing and says so
command:        # python -m pytest -q --junitxml=.junit.xml {target}
timeoutSeconds: # 600
```

**The command is configuration, never an argument.** A tool that runs what it is handed is a
remote shell with a tool's name. A caller may narrow a run, and only by filling a slot the
configuration named in advance: `{target}` takes a relative path, validated to stay inside the
workspace and to contain nothing a shell would read as syntax.

## What it deliberately does not do

**It does not write the ontology.** It produces facts and hands them back; recording them is the
domain's business — the domain declares a `record_test_run` action and the roles permitted to call
it. That separation is why this plugin imports nothing from the ontology package, and why it can be
installed into any deployment whose tests are run this way. A capability that knew what a
`TestRun` was would have to know the customer's world.

## Two things found by running it, not by reading it

**junit's `failure` and `error` do not mean "assertion" and "exception".** They mean *the test ran
and came out wrong* and *the test never ran* — a `RuntimeError` raised inside a test body is a
`<failure>`, because pytest treats "ran and raised" as failing; `<error>` is for a fixture or the
collection above it blowing up. Verified by running both.

**The distinction a reader actually wants is in the message, not the structure.** pytest writes the
exception's name at the front of the failure message, so `AssertionError` and everything else can
be told apart, and that is what `kind` records. The two send a reader to different files: a wrong
answer is the product's, an unhandled error is the test's. Triage puts them in that order.

## Verifying

```sh
npm test        # the parser, against XML trimmed from a real pytest run
```

The suite covers both outcomes above, a message whose newlines arrive as `&#10;`, a failure whose
text mentions `<error` (which a substring search would misread), and a case identifier embedded in
a name after an underscore.

**Windows-only?** No. It runs a command; the command decides what that means.
