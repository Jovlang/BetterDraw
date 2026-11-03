# BetterDraw

Sketch inside an Obsidian note with a mouse, pen, or touch.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to
`.obsidian/plugins/betterdraw/` in your vault (use your configured vault
settings folder if it differs). Reload Obsidian and enable **BetterDraw**
under **Settings > Community plugins**. There is no build step.

## Draw

1. Open a note in Live Preview and run **BetterDraw: Insert drawing** from
   the command palette.
2. Draw in the inline canvas. Each completed stroke saves automatically.
3. Use **Undo stroke** to remove the last stroke.

Drawings also work in Reading view. Each drawing is an ordinary SVG in the
vault's `BetterDraw/` folder. Its BetterDraw block references the file by path.
Copying the block references the same drawing, so edits appear in both places.
Keep the adjacent Markdown image if you want a copy of the block to stay
visible when BetterDraw is disabled.

Include the SVG files when backing up, syncing, or exporting your vault.
Removing a reference leaves the SVG in the vault.

Drawings created by the ID-based prototype are not migrated automatically.

## Tests

Run `node --test` from the repository folder.
