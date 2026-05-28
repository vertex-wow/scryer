# ADR 007 — Flavor config merge order: authorship tier before specificity tier

**Status:** Decided (2026-05-28)

## Context

The flavor config system has five layers that are merged in order, with later layers winning:

1. Hard defaults (TypeScript constants — ultimate fallback)
2. Built-in default (shipped `defaults.json`, `default` section)
3. Built-in per-flavor (shipped `defaults.json`, per-flavor section)
4. User default (user-supplied JSON, `default` section)
5. User per-flavor (user-supplied JSON, per-flavor section)

The question was whether to interleave by specificity (default before per-flavor across both sources) or by authorship tier (all built-in layers before all user layers), and which was the correct ordering within each approach.

## Options considered

**Option A — specificity within authorship tier (implemented)**
`hard defaults → built-in default → built-in per-flavor → user default → user per-flavor`

User layers always beat built-in layers at the same level of specificity, and per-flavor always beats default within the same source.

**Option B — authorship tier first, then specificity**
`hard defaults → built-in default → user default → built-in per-flavor → user per-flavor`

All user layers are applied before any built-in per-flavor layer, meaning built-in per-flavor overrides user default.

## Decision

**Option A.**

## Rationale

Option B has a critical flaw: a built-in per-flavor key would silently override the user's global default. For example, if the user sets `uiParentWidth: 1920` in their `default` section to standardize all previews, a shipped `retail: { uiParentWidth: 1024 }` would clobber it. The user cannot win globally without knowing which flavors the extension specializes and patching each one individually.

Option A maintains the correct invariant: **the user always wins over built-in at the same or lower specificity.** The ordering by tier within authorship (default < per-flavor) is consistent and intuitive — a per-flavor entry is more specific than a default entry, within the same source.

The rule is simple: "user beats built-in; per-flavor beats default within a source."

## Consequences

- Users who want to globally override a value simply set it in their `default` section — it overrides both built-in default and built-in per-flavor for that key.
- Users who want a flavor-specific override set it in the per-flavor section of their file — it wins over everything except their own higher-specificity keys.
- Built-in per-flavor sections are only authoritative when the user has not set the key in either their default or per-flavor sections.
