# DeepWork

> An enterprise AI workspace built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).
>
> **Turn business intent into executable work.**

## Why

DSH ships a very complete agent harness: agent loop, tools, skills, workflows, plan mode,
approval, subagents, sandboxing. What it does not ship is any notion of the *enterprise world*
the agent is working in — no ontology, no knowledge layer, no long-term memory, no tenancy.

```
DSH ships            DeepWork adds
─────────────        ──────────────
agent loop           ontology      (entities, relations, actions)
tools                knowledge     (facts grounded in the ontology)
skills               memory        (user / task / session)
workflow             governance    (permission, policy, human review)
plan mode
human review
```

The gap is semantic, not mechanical. A general agent sees `document_001`, `project_782`,
`user_23891`. An enterprise agent needs to know what a *project* is, who owns it, which
customer it belongs to, and what it is allowed to touch.

## Positioning

DeepWork is **a plugin, not a fork**. It extends DSH through its published extension points
and follows upstream releases instead of diverging from them.

- License: MIT (same as upstream)
- Naming follows the [DeepSeek Harness brand guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md):
  no use of the "DeepSeek Harness" trademark in the project name, relationship described as "built on DSH".
- Ecosystem: tagged [`dsh-plugin`](https://github.com/topics/dsh-plugin) on GitHub.

## Status

Early. Scaffolding in progress.
