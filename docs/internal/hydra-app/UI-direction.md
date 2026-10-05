# Hydra app: UI direction

Nico's direction for the app's visual design pass (2026-10-03). The pass comes after the app's goals work end to end; until then, features first.

## Overall
Hydra should feel like a serious native coding tool, closer to Claude Code and Cursor than to a branded AI dashboard.

**Avoid:**
- Green-tinted surfaces, and green selection backgrounds.
- Excessive rounded cards.
- Too many coordinated brand colours.
- Over-designed gradients or decorative elements.
- Hydra green on every UI state.
- Anything that feels like a generic AI SaaS dashboard.

## Light mode
A warm off-white canvas and a slightly darker neutral sidebar, with neutral grey hover and selected states. Borders are very subtle, text is mostly black or dark grey, and green appears only for important active states and brand moments.

| Token | Colour |
| --- | --- |
| Canvas | #FBFBFA |
| Sidebar | #F7F7F5 |
| Hover | #ECECEA |
| Selection | #E7E7E4 |
| Border | #E3E3E0 |
| Primary text | #20201E |
| Muted text | #73736E |
| Hydra green | #1F7A4D |

## Dark mode
A Cursor-style near-black base, with the sidebar only slightly separated from the editor. Hover and selected states are neutral dark grey and borders very subtle. Text is off-white rather than pure white. The green is brighter than in light mode so it stays visible on black.

| Token | Colour |
| --- | --- |
| Canvas | #141414 |
| Sidebar | #181818 |
| Elevated surface | #1B1B1B |
| Hover | #222222 |
| Selection | #292929 |
| Border | #2A2A2A |
| Primary text | #ECECEC |
| Muted text | #999999 |
| Hydra green | #42A875 |

## Hydra green
**Use it for:**
- active branch and status indicators;
- primary buttons;
- focused controls;
- success states;
- active icons;
- small identity details;
- selected tabs, where appropriate.

**Never use it for:**
- entire sidebars;
- normal hover states;
- every selected row;
- body text;
- large background areas;
- every card or container.

## Layout and style
**Structure:**
- Follow the Claude desktop app's structure closely.
- Let whitespace separate sections instead of cards, and prefer thin separators over boxed containers.
- Keep the sidebar visually quiet, and let the code and editor area be the visual focus.

**Controls and density:**
- Keep corner radii modest.
- Use compact spacing suited to a developer tool.
- Use native-feeling controls, not SaaS-style pill buttons.
- Keep branch, task and status rows dense and functional.

**Colour:** semantic colours stay semantic, such as red for errors and deletions, and amber for warnings.

**Target feel:** Claude's restraint in light mode, Cursor's restraint in dark mode, and a small amount of Hydra green identity.
