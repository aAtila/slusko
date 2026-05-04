# ADR 0011: Use repo-root Lefthook for web DX tooling under single-polyglot-repo constraints

- Status: accepted
- Date: 2026-05-04

## Context

Per ADR 0009, this repository intentionally has no root JavaScript workspace tooling and keeps JS package management scoped to `web/`.

Issue #2 requires pre-commit automation for formatting and linting web files, plus local editor alignment, without introducing a root `package.json` or workspace manager.

We need hook behavior that is:

- repo-wide and easy to install,
- explicit about running commands in `web/`,
- compatible with contributors who do not share identical local shell setup,
- and still aligned with ADR 0009 boundaries.

## Decision

Use **Lefthook at repo root** with commands rooted in `web/`:

- format staged web files with Prettier (`--write`) and restage modified files,
- lint staged web files with oxlint as a non-autofix quality gate.

Keep formatter/linter dependencies and config inside `web/` only.

## Why Lefthook over alternatives

### vs Husky

Husky is tightly coupled to npm lifecycle/package scripts and usually assumes a JS package anchor at the hook owner level. Under ADR 0009, we do not want to introduce root JS package/workspace scaffolding just to host git-hook orchestration. Lefthook avoids that coupling and can orchestrate commands for `web/` from repo root without adding root `package.json` tooling.

### vs native git hooks (`core.hooksPath` + shell scripts)

Native hooks are viable but push more responsibility onto per-developer shell portability, script maintenance, and cross-platform edge cases. They also provide weaker built-in ergonomics for staged-file filtering and restaging after formatter writes. Lefthook gives declarative hook config, staged-file targeting, and predictable team setup with a single install step.

## Consequences

- Preserves ADR 0009 boundaries (no root JS workspace tooling).
- Gives uniform pre-commit behavior across contributors.
- Keeps command surface explicit (`bun run format`, `bun run lint`) for manual verification.

## Migration trigger

Re-evaluate this decision if either of these occurs:

1. a second JS package is introduced in the repository, or
2. root-level JS workspace tooling is added (for example, root `package.json` + workspace manager).

At that point, consider consolidating hook/tooling ownership at workspace root if it improves consistency without violating newer architecture constraints.
