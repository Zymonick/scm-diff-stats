# SCM Diff Stats

A VS Code extension that adds a **Diff Stats** panel to the Source Control sidebar with per-file `+x −y` line counts — something the built-in Changes view cannot show (its API caps external decorations at a 2-character badge).

For every repository / git worktree open in the workspace:

- **Staged / Changes** — each file with green `+added` / red `−deleted` line counts in aligned columns next to a colored git status letter (M/A/D/R/U). Untracked files count their lines as additions. Clicking a file opens its diff.
- **Vs master** — for branches other than `master`: how many commits the branch is **behind master** (red `↓N`), total `+x −y` relative to the merge base (`git diff master...HEAD`, so master moving ahead doesn't pollute the numbers), and a per-file drill-down; clicking opens a merge-base ↔ working-tree diff.
- **Commits** — outgoing commits when an upstream exists, otherwise the most recent ones, each with `+x −y` vs its parent. Expanding a commit lazy-loads its files; clicking opens the parent ↔ commit diff for that file.
- Hover tooltips with `+x −y` on the **built-in** SCM rows (via a `FileDecorationProvider`).
- Auto-refreshes on git state changes and file saves; manual ↻ button in the panel title.

The panel is a webview (custom HTML/CSS) — that is what allows colors and aligned columns, at the cost of the file-icon-theme glyphs a native tree would have.

## Install

Grab the `.vsix` from the latest release, then:

```bash
code --install-extension scm-diff-stats-<version>.vsix
```

and reload the window. If the panel doesn't appear, it's collapsed at the bottom of the Source Control sidebar, or hidden — right-click a section header there and tick **Diff Stats**.

## Develop

Everything lives in `extension/extension.js` (plain JS, no build step, no dependencies).

```bash
./build.sh   # zips the vsix and reinstalls it locally; then reload the window
```

Bump `version` in `extension/package.json` **and** in `extension.vsixmanifest` when releasing.
