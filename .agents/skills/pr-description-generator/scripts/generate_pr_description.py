#!/usr/bin/env python3

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import List, Optional, Tuple


def _run_git(args: List[str], *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _git_ok(args: List[str]) -> bool:
    try:
        _run_git(args, check=True)
        return True
    except subprocess.CalledProcessError:
        return False


def _detect_base_branch(preferred: str) -> str:
    candidates = [preferred]
    if preferred != "origin/develop":
        candidates.append("origin/develop")
    if preferred != "develop":
        candidates.append("develop")

    for c in candidates:
        if _git_ok(["rev-parse", "--verify", c]):
            return c

    raise RuntimeError(
        "Cannot find base branch. Tried: " + ", ".join(candidates) + ". "
        "Fetch remotes or pass --base explicitly."
    )


def _ensure_fetched(base: str, *, no_fetch: bool) -> None:
    if no_fetch:
        return
    if not base.startswith("origin/"):
        return
    # Best-effort fetch; keep it non-fatal to support offline use.
    try:
        _run_git(["fetch", "origin", "develop"], check=False)
    except Exception:
        pass


def _current_branch() -> str:
    cp = _run_git(["branch", "--show-current"], check=True)
    b = cp.stdout.strip()
    return b or "(detached)"


def _repo_root() -> str:
    cp = _run_git(["rev-parse", "--show-toplevel"], check=True)
    return cp.stdout.strip()


def _commit_subjects(base: str, head: str) -> List[str]:
    cp = _run_git(["log", "--no-merges", "--format=%s", f"{base}..{head}"])
    subjects = [s.strip() for s in cp.stdout.splitlines() if s.strip()]
    return subjects


def _changed_files(base: str, head: str) -> List[str]:
    cp = _run_git(["diff", "--name-status", f"{base}...{head}"])
    lines = [ln.rstrip() for ln in cp.stdout.splitlines() if ln.strip()]
    return lines


def _diffstat(base: str, head: str) -> str:
    cp = _run_git(["diff", "--stat", f"{base}...{head}"])
    return cp.stdout.rstrip()


def _is_migration_touched(changed_files: List[str]) -> bool:
    for ln in changed_files:
        parts = ln.split("\t")
        if not parts:
            continue
        path = parts[-1].strip()
        if path.startswith("drizzle/") and path.endswith(".sql"):
            return True
    return False


def _guess_title(subjects: List[str], branch: str) -> str:
    if subjects:
        return subjects[0]
    return f"PR: {branch}"


def _normalize_summary_bullet(s: str) -> str:
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\(#\d+\)$", "", s).strip()
    return s


def _summary_bullets(subjects: List[str]) -> List[str]:
    if not subjects:
        return ["No commits found between base and HEAD (check base branch)."]

    bullets: List[str] = []
    seen = set()
    for s in subjects:
        b = _normalize_summary_bullet(s)
        if not b:
            continue
        key = b.lower()
        if key in seen:
            continue
        seen.add(key)
        bullets.append(b)
        if len(bullets) >= 6:
            break

    return bullets


def _suggest_testing_commands() -> List[str]:
    cmds: List[str] = []
    if os.path.exists("mise.toml") or os.path.exists(".mise.toml"):
        cmds.append("mise run ci")
    if os.path.exists("pnpm-lock.yaml"):
        cmds.append("pnpm -s run ci:pr")
    if not cmds:
        cmds.append("<add your local test command>")
    return cmds


@dataclass
class PRData:
    title: str
    base: str
    head: str
    branch: str
    subjects: List[str]
    summary: List[str]
    changed_files: List[str]
    diffstat: str
    testing: List[str]
    notes: List[str]


def _build_pr_data(*, base: str, head: str, title: Optional[str], no_fetch: bool) -> PRData:
    _ensure_fetched(base, no_fetch=no_fetch)
    base = _detect_base_branch(base)

    branch = _current_branch()
    subjects = _commit_subjects(base, head)
    changed_files = _changed_files(base, head)
    diffstat = _diffstat(base, head)
    summary = _summary_bullets(subjects)

    notes: List[str] = []
    if _is_migration_touched(changed_files):
        notes.append("Includes DB migration changes; ensure migration applies cleanly.")

    final_title = title.strip() if title and title.strip() else _guess_title(subjects, branch)

    return PRData(
        title=final_title,
        base=base,
        head=head,
        branch=branch,
        subjects=subjects,
        summary=summary,
        changed_files=changed_files,
        diffstat=diffstat,
        testing=_suggest_testing_commands(),
        notes=notes,
    )


def _render_markdown(pr: PRData) -> str:
    lines: List[str] = []
    lines.append(f"# {pr.title}")
    lines.append("")
    lines.append("## Summary")
    for b in pr.summary:
        lines.append(f"- {b}")
    lines.append("")
    lines.append("## Changes")
    if pr.changed_files:
        lines.append("Changed files:")
        lines.append("")
        lines.append("```text")
        lines.extend(pr.changed_files)
        lines.append("```")
    else:
        lines.append("- No file changes detected (check base branch).")
    if pr.diffstat:
        lines.append("")
        lines.append("Diffstat:")
        lines.append("")
        lines.append("```text")
        lines.append(pr.diffstat)
        lines.append("```")

    lines.append("")
    lines.append("## Testing")
    for c in pr.testing:
        lines.append(f"- `{c}`")

    if pr.notes:
        lines.append("")
        lines.append("## Notes")
        for n in pr.notes:
            lines.append(f"- {n}")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(f"Base: `{pr.base}`")
    lines.append(f"Head: `{pr.head}`")
    lines.append(f"Branch: `{pr.branch}`")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Generate a copy-pastable PR description from git diff vs develop."
    )
    ap.add_argument(
        "--base",
        default="origin/develop",
        help="Base branch/ref to compare against (default: origin/develop).",
    )
    ap.add_argument(
        "--head",
        default="HEAD",
        help="Head ref to compare (default: HEAD).",
    )
    ap.add_argument("--title", default=None, help="Override PR title.")
    ap.add_argument(
        "--no-fetch",
        action="store_true",
        help="Do not fetch origin/develop before computing the diff.",
    )

    args = ap.parse_args()

    try:
        _repo_root()  # ensure we're in a git repo
        pr = _build_pr_data(
            base=args.base,
            head=args.head,
            title=args.title,
            no_fetch=args.no_fetch,
        )
    except Exception as e:
        sys.stderr.write(f"error: {e}\n")
        return 2

    md = _render_markdown(pr)
    sys.stdout.write("```markdown\n")
    sys.stdout.write(md)
    sys.stdout.write("```\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
