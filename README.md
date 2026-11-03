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
3. Use **Undo stroke** to remove the last stroke. Use **Save** to retry
   after a save error.

Drawings also work in Reading view. Source mode shows the Markdown block
and its drawing ID. Copying the block within a vault displays the same
drawing. Moving a note to another vault requires copying the matching
drawing data from the plugin folder's `data.json`.
