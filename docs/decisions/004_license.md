# ADR 004 — License

**Status:** Accepted  
**Date:** 2026-05-24

## Context

The project is a standalone VSCode extension: a WoW addon previewer/sandbox. The
author plans intermittent involvement (months active, years away) and wants the
project to serve as a community PoC and starting point. Key concerns:

- Attribution must be preserved
- Proprietary closed-source forks should be prevented
- Cloud/SaaS use without sharing source should be prevented
- Commercial ports to other Lua-plugin ecosystems should require giving back
- Licensing overhead must be minimal — no ongoing gatekeeping required

## Options Considered

MIT, Apache-2.0, GPLv3, AGPLv3, SSPL, BSL, dual-license (copyleft + proprietary)

Full analysis in conversation context (2026-05-24). Key findings:

- **MIT/Apache:** permitted proprietary forks and closed SaaS — rejected for this use
- **GPLv3:** prevents closed distributed forks but leaves the SaaS/hosted-service loophole
- **AGPLv3:** closes the SaaS loophole (Section 13: modified code run as a network service must be offered as source to users); the strongest mainstream copyleft that matches the stated goals
- **SSPL:** more aggressive than AGPL; not OSI-approved; not needed here
- **BSL:** commercial-runway tool for funded companies; converts to open during author's absence anyway; requires custom legal drafting
- **Dual license (AGPL + proprietary):** lets the author grant commercial licenses to parties who need to use the code without AGPL obligations; does not require a full CLA if contributors license their contributions permissively

## Decision

**Dual license: AGPL-3.0-only (public) + proprietary commercial (at author's discretion).**

Contributions are accepted under MIT, which is inbound-compatible with both AGPL
and proprietary, allowing the author to incorporate them in both releases without
requiring a formal CLA.

## Rationale

AGPLv3 is the appropriate license because:

1. **Prevents closed distributed forks** — any fork distributed (e.g., on the VSCode
   Marketplace) must ship complete corresponding source.
2. **Prevents closed SaaS** — Section 13 catches the "run modified code as a hosted
   service without distributing it" case that plain GPL misses.
3. **Keeps derivatives in the commons** — forks of the previewer remain open, which
   directly serves the community-continuity goal.
4. **Applicable to this audience** — the WoW addon developer community is comfortable
   with copyleft; "coder ick" about AGPL is an enterprise concern that doesn't apply
   to hobbyist contributors.

The proprietary tier exists as a safety valve: if a legitimate commercial use case
arises (e.g., a company wants to embed this in a closed product), the author can
grant a license rather than forcing a ground-up rewrite. The author has no intention
of running an active commercial licensing business; this is a low-overhead option.

## Effect on addon authors

None. The AGPL applies to the previewer's own source and to derivative works of it.
Addons previewed with the tool are input/data — they are not derivatives of the tool
any more than a compiled program is a derivative of GCC. Addon authors license their
work however they choose.

## Contributor model

Contributors license contributions under MIT (broad, permissive, no copyright
assignment). This is stated in `CONTRIBUTING.md` and enforced by a PR template
checkbox. MIT is inbound-compatible with both AGPL and proprietary, so the author
can incorporate contributions into both releases. No CLA signature is required.

## VSCode Marketplace compatibility

No incompatibility. `vscode` is `external` in the build (never bundled); `@types/vscode`
is dev-only (never shipped); the only bundled runtime dep is `fast-xml-parser` (MIT,
inbound-compatible with AGPL). The Marketplace does not require a permissive license.

## Inbound mechanism: checkbox vs DCO

The Developer Certificate of Origin (DCO) — a `Signed-off-by` commit trailer
enforced in CI — is a more robust provenance mechanism than an optional PR
checkbox, and is zero per-contributor paperwork. It was considered and
declined: the DCO alone establishes that a contributor has rights to submit,
but does not grant relicensing rights; combining DCO + an explicit license
grant would be stronger, but adds a CI step and commit-discipline overhead
disproportionate to a solo hobbyist project. The checkbox approach is
honest about its lightness — the CONTRIBUTING.md makes the ask explicit
and the PR template makes it visible, which is enough for the realistic
contributor base (hobbyists, community members).

If the project ever attracts commercial contributions or the proprietary
tier becomes financially meaningful, the right upgrade is a DCO check + a
brief explicit grant statement in the commit trailer format, not a full CLA.

## Succession intent

This project is designed to outlive the author's active involvement — extended absence or permanent departure is planned, not an edge case. The licensing structure reflects that intent:

The **AGPLv3 path is permanent and unconditional**. Any future maintainer who continues the project under AGPL may run it, modify it, distribute it, and sustain themselves around it — via sponsorships, Patreon, paid support, hosted services, or any other model — provided the AGPL source-sharing obligations are met. That latitude is deliberate. A community successor should not be stranded by a license structure that depended on the original author being reachable.

The **proprietary commercial path is personal and non-transferable**. Only the original author can grant a license to use this software outside AGPL's terms. That authority does not pass to forks, maintainers, or successors. In practice, this path ends when active involvement ends. Any future fork not explicitly licensed by the original author operates under AGPLv3 — that is the intended outcome, not a gap.

**Why no Commons Clause:** Commons Clause was considered and rejected specifically because it would contradict this succession goal. CC's commercial prohibition has no carve-out for a future maintainer sustaining themselves — and with the proprietary-license path gone, there would be no one to grant an exception. Adding CC would hand a future maintainer a project with a permanent ceiling on how they could support themselves. AGPL alone is the right instrument: its source-sharing requirement provides sufficient friction against closed commercial exploitation without foreclosing the open paths a successor needs.

## Consequences

- `LICENSE` contains AGPL-3.0 text (GitHub detects and displays correctly)
- `LICENSE-COMMERCIAL` describes the proprietary licensing option and contact
- `CONTRIBUTING.md` states the MIT contribution model and explains the rationale
- `.github/PULL_REQUEST_TEMPLATE.md` has a contribution-license acknowledgment checkbox
- `package.json` `"license"` field: `"AGPL-3.0-only"`
- Bundled third-party data from `ketho.wow-api` (MIT) retains its own copyright notices

## References

- [plan/000_overview.md](../plan/000_overview.md)
- `LICENSE`, `LICENSE-COMMERCIAL`, `CONTRIBUTING.md`
- `_reference/vscode-wow-api/LICENSE` (MIT — ketho's data, preserved separately)
