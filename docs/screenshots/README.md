# Screenshots

Drop PNGs here with the filenames referenced from the project README.
Targets and capture suggestions are listed below. All shots should be
taken at the **standard 1× viewport** (no zoom), in a window roughly
1400–1800 px wide so the three-pane layout reads cleanly when
GitHub shrinks the image.

Tip: `⌘+Shift+5` on macOS gives you a region-select recorder. After
capturing, run images through `pngquant` or `oxipng -o4 file.png` to
keep the repo small.

## Files referenced from README.md

### `hero.png` (required)

The "front-page" shot. Should show the full three-pane window:

- Left sidebar: a list of .md files in `manuscript/`, with one
  highlighted as active.
- Centre: a rendered paper-like article (e.g. `introduction-merged.md`),
  with at least one yellow `<mark>` highlight visible mid-text and
  visible `§S ¶N` markers in the left margin.
- Right pane: 2–4 comment cards, including at least one with a
  visible "Edit / Delete" set of buttons.

Aim for ~1600×900 px source resolution; GitHub will render around
1280 px wide on a desktop.

### `annotation-flow.png`

Mid-action shot of the comment popup. Capture state:

- Some text in the article selected (e.g. a phrase like "imbalance"
  in `introduction-merged.md`).
- The pending dashed-orange highlight visible on that text.
- The comment popup open, anchored below the selection, with the
  anchor label `§1 ¶3 — whole paragraph` (or similar) visible at
  the top and a few words typed in the textarea.

Crop to the article column + popup (no need for sidebars). ~900×600 px.

### `table-editor.png`

The visual table editor modal open on a non-trivial table — the
`§7.5` "Phrase-level red flags" table in `CLAUDE.md` is a good source.
Show:

- 4 columns × 3+ rows.
- Cells that contain multi-line content (so the textarea autogrow is
  visible).
- The `−` column-delete buttons above the header, the `−` row-delete
  buttons on the left.
- The `+ Row` / `+ Column` / `Cancel` / `Apply` footer.

Crop to the modal. ~1000×600 px.

### `export.png`

The Export modal open after a session of annotation. Show:

- The `=== filename.md ===` headers,
- a mix of `§S ¶N` + `> "quote"` + comment blocks,
- one `[note]` (general note) entry.
- The footer with *Copy to clipboard* / *Save as file…* /
  *Delete all*.

Crop to the modal. ~800×700 px.

## Optional / future

- `rules-editor.png` — the structured CLAUDE.md editor with H2/H3
  cards.
- `hover-coupling.gif` — hovering a mark in the article lighting up
  the matching card on the right (and vice versa). GIF only if you're
  willing to convert with `ffmpeg`.

To turn a `.mov` from macOS screen recording into a compact GIF:

```sh
ffmpeg -i input.mov -vf "fps=15,scale=1200:-1:flags=lanczos" -loop 0 output.gif
gifsicle -O3 output.gif -o output-optimized.gif
```

Keep GIFs under ~3 MB; GitHub caps individual file size and large GIFs
hurt page load.
