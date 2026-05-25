# Contributing

## License of contributions

This project is dual-licensed: publicly under the GNU Affero General Public
License v3.0 (AGPL-3.0-only), and privately under a proprietary commercial
license available from the copyright holder (see LICENSE-COMMERCIAL).

**By submitting a pull request or patch, you license your contribution under
the MIT License**, granting the copyright holder (Vertex Industries) the right
to incorporate your work into both the AGPL-licensed public release and any
proprietary commercial release. You retain copyright over your own
contribution; you are not assigning copyright, only granting a broad license.

This is intentionally lightweight — no CLA signature required. Two things are
required:

1. **Sign off your commits** with `git commit -s`. This appends
   `Signed-off-by: Your Name <email>` to the commit message using your
   existing git config — no extra setup needed. It certifies you have the
   right to submit the code (the [Developer Certificate of Origin](https://developercertificate.org/)).

2. **Check the license box** in the pull request template, acknowledging that
   your contribution is licensed under MIT as described above.

If you submit a patch outside of a PR (e.g. via issue attachment), include
`Signed-off-by: Your Name <email>` and the line
`I license this contribution under the MIT License` in your message.

### Why MIT for contributions?

Dual licensing requires the project owner to have rights to use contributions
in both the open-source and proprietary versions. MIT is the simplest license
that grants those rights while leaving your copyright intact and not imposing
any obligations on how you use your own contribution elsewhere.

### What this means for addon authors

If you use this tool to preview your addon, your addon is **not** affected by
this project's license. The AGPL applies only to the previewer's source code
and to derivative works of it — not to the addons you run through it. Addon
authors license their own work however they choose.

## Practical guidelines

- Open an issue before large changes to avoid duplicated effort.
- Match the existing code style (TypeScript strict, no unnecessary comments).
- Update `docs/` if your change affects architecture, scope, or documented
  decisions — see `CLAUDE.md` for documentation conventions.

## Environment Setup

fnm + Node 24.16

```
curl -fsSL https://fnm.vercel.app/install | bash
source /home/goldilocks/.bashrc
fnm install 24.16.0
fnm use
```
