# Copilot instructions

## Tooling preferences

### Avoid slow search subagents for simple tasks

The code-search subagent (`search_code_subagent`) is very slow in this
workspace — it can take ~10+ minutes to return. Do **not** use it for simple,
targeted lookups.

Instead, for finding code, symbols, files, or references, use the fast direct
tools:

- `grep` for content/regex searches (narrow with `glob`/`type` filters)
- `glob` for finding files by name/pattern
- `view` for reading specific files or line ranges

Only consider a search subagent when the task genuinely needs broad, open-ended
exploration across many independent threads that won't fit in direct reads — and
even then, prefer a few direct `grep`/`view` calls first. When in doubt, search
directly.
