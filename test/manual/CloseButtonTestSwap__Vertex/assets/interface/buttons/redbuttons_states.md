The redbuttons.blp sheet is 128×64 and packs three states for each button variant in vertical strips:

| y range | atlas entry | state |

|---------|---------------------------|--------------------------------|

| 1–19 | `redbutton-exit` | normal (default, no interaction) |

| 22–40 | `redbutton-exit-disabled` | disabled (button is greyed out) |

| 43–61 | `redbutton-exit-pressed` | pushed (held down / clicked) |

Row 0 and the 2px gaps at rows 20–21 and 41–42 contain the semi-transparent shadow/glow pixels that bleed outside each sprite's crop boundary.

We currently only ever sample y=1–19 (the normal state). The disabled and pushed states are never sampled because generateTemplateBody only emits SetNormalAtlas so far — SetDisabledAtlas and SetPushedAtlas haven't been wired up yet.
