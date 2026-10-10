# Docs become committed agent memory in .agents/notes

> Date: 2026-10-10 · Status: accepted (done) · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

All development documentation — product direction, features, architecture, decisions, research, and agent discussion logs — lives in `.agents/notes/`, structured feature-wise. Agents are the primary writers and readers. It is agent memory committed to the repo.

## Location

Moved from `agents/notes/` to `.agents/notes/` on 2026-10-10 (user), beside `.agents/skills/` (`.claude` → `.agents` symlink).

## What moved

| From                           | To                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `PRODUCT.md`                   | `product/overview.md`, `product/roadmap.md`, feature Product sections                        |
| `FLOW.md`                      | feature Flow sections, `design/app-shell.md`, `product/overview.md` (personas, golden paths) |
| `TECH.md`                      | `architecture/*.md`, feature Tech sections                                                   |
| `DESIGN.md`                    | `design/design-system.md`                                                                    |
| `docs/*.md`                    | `architecture/` (deploy, registry-v2, security-compliance), `research/` (product discovery)  |
| `.project/BACKLOG.md`          | `product/roadmap.md`                                                                         |
| `.project/PLAN.md`             | `history/build-plan.md` + `architecture/dev-environment.md` + decision records               |
| `.project/stripe-discovery.md` | `research/stripe-connect-discovery.md`                                                       |
| `.project/findings/`           | `findings/`                                                                                  |
| `.project/prompts/`            | `history/build-prompts/`                                                                     |

Root keeps `README.md`, `SECURITY.md`, `LICENSE`, `AGENTS.md` (→ `CLAUDE.md`). `docs/` was deleted entirely (retired, unreferenced media) — see [repo cleanup](2026-10-10-repo-cleanup.md).

## Rules

Conventions live in [.agents/notes/README.md](../README.md).
