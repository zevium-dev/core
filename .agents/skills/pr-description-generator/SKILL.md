---
name: pr-description-generator
description: Generate a copy-pastable GitHub PR description by comparing the current git branch against the develop branch (or origin/develop). Use when preparing a PR and you want an accurate summary based on commits + file diffs.
---

# PR Description Generator

Generate a PR description from real git deltas (commit subjects + file changes) so the PR body stays accurate and easy to review.

## Quick Start

```bash
python3 .agents/skills/pr-description-generator/scripts/generate_pr_description.py
```

## Options

- Use a different base branch:

```bash
python3 .agents/skills/pr-description-generator/scripts/generate_pr_description.py --base develop
python3 .agents/skills/pr-description-generator/scripts/generate_pr_description.py --base origin/develop
```

- Provide an explicit title:

```bash
python3 .agents/skills/pr-description-generator/scripts/generate_pr_description.py --title "<your title>"
```

- Avoid fetching (offline / no remote access):

```bash
python3 .agents/skills/pr-description-generator/scripts/generate_pr_description.py --no-fetch
```

## Output Contract

The script prints exactly one fenced markdown block you can copy into GitHub.

- `## Summary`: 3-6 bullets inferred from commit subjects
- `## Changes`: changed files (name-status) + diffstat
- `## Testing`: suggested local CI command(s)
- `## Notes`: low-volume hints (e.g. migrations)
