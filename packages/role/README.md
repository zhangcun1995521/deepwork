# @zhangcun123/role

## Install

```sh
dsh plugin --profile web add @zhangcun123/role
```

Then add `@zhangcun123/role` to `dsh.profile.bundles` in the profile's `package.json` (the plugin manager does
both steps). Requires DeepSeek Harness `0.1.7-rc.2` and up within the `0.1` line: the manifest declares
that range as a peer dependency, and the harness refuses a plugin built for a different runtime instead
of loading it into one — which is the failure this package would rather have.

> The role a mode acts as, and the prompt it works under.

A **mode** is an agent preset, and a mode has to be able to say who its agents are. This plugin is
that sentence and nothing else. It registers **no tools**, so mounting it costs nothing and
duplicates nothing — which is exactly why it is a package rather than two more fields on another
one.

## Why this is not part of the ontology

The ontology is about **what the enterprise is**: its types, its relations, who may write what. A
prompt is a statement about **who an agent is**. Those are different subjects, and the role fields
started on the ontology only because the ontology mount happened to be the one thing a mode could
configure. The cost of leaving them there is concrete: a mode that wants to state its role would
have to mount the ontology a second time, and a second mount registers every derived tool a second
time.

So the role lives here, and it is the *prompt* half of a mode: this row mounts the text its own
agents work under, and nothing else.

**It used to publish the role for the ontology to select rules by, and that channel is gone.** It
was a service name both packages stated and neither imported, and it could never deliver: a mode's
rows are mounted in the mode's own realm, so a role published there is visible to the mode's subtree
and invisible to the ontology, which the profile mounts outside it. The arrangement that made it
fail was worse than useless — a mode's row that publishes into the *root* realm has its whole mode
rejected (`Preset services require isolate realms`), which the interface renders as a mode that is
simply missing, with nothing written to any log. Which role a deployment acts as is stated where the
ontology is mounted, as the `situation` tag the domain selects rules by; this row states the role
only to pick the prompt. See `packages/ontology`'s `situation` config.

## Configuration

```yaml
role: curator                  # the role this mode acts as; unset means the mode states none
prompts:                       # role → absolute path to a text file
  curator: /somewhere/curator.txt
```

`role` selects the entry in `prompts`. The file is read once, at load, and mounted as a prompt
section named `deepwork:role-prompt`, ranked just behind the deployment's own persona and just ahead
of the rules the ontology injects: who this agent is, then what it must follow, then the tools.

**It is a path, not a prompt body.** A prompt is prose somebody edits and reviews, and a composition
file is where settings live, not paragraphs. The text is mounted verbatim — `interpolate: false` —
because prose contains braces, and the prompt registry's `{{variable}}` references are strict.

## What it does not do

**It does not refuse to start.** A missing file, an empty file, or a role with no `prompts` entry is
reported and the mode comes up without a prompt. A prompt is the one part of a mode whose absence
degrades *manner* rather than *capability*, and failing a boot over it would take the agent's tools
down with it.

**It is not who may write.** A deployment's role map answers "who is this caller" for the write
path, has to fail closed, and is a security decision. This answers "who is this agent", which is a
fact about how a mode is composed. A deployment that wants both states both, and conflating them
would let a mode grant itself write authority by naming a role.

**It does not read the domain.** Nothing here imports the ontology package. This plugin knows a role
name and a file path, which is what lets it be mounted beside any deployment.

## Verifying

```sh
npm test        # the prompt's section, the ordering around it, and the ways it can be absent
npm run build
```

No runtime, no profile, no domain on disk: the prompt registry is a named interface here, not an
imported one.
