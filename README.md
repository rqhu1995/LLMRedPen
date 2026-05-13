# LLMRedPen

A small browser-based tool for reviewing the long-form Markdown a
language model just wrote you — highlighting passages, attaching
comments, and exporting the whole batch back to the model in one block.

The aim is to bring the rhythm of paper review — careful reading, red-pen
margins, then handover to the author — into LLM-assisted writing, without
turning the user into a full-time editor.

![LLMRedPen — reading and annotating an LLM-written manuscript draft](docs/screenshots/hero.png)

---

## Table of contents

- [Why this tool exists](#why-this-tool-exists)
- [Screenshots](#screenshots)
- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Working with an LLM agent](#working-with-an-llm-agent)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Project layout](#project-layout)
- [License](#license)

---

## Why this tool exists

Working with LLMs on long-form writing has settled into a familiar loop:
paste a lot of text, get a lot of text back, scroll past most of it,
send the next message. The pile of unreviewed output snowballs. What
was meant to be a collaboration drifts into one party writing and the
other party tolerating.

The user isn't lazy. The reviewer's chair just isn't there.

**Markdown reads like a note, not a manuscript.** Heading hashes,
citation tokens, hard-wrapped lines, embedded comments — even rendered
in Typora or a VS Code preview, a Markdown draft feels like an informal
write-up, not a paper to focus on. There is no "I am reading a
manuscript" mode that invites careful reading.

**Markdown has no native annotation surface.** PDFs have margin
comments; Word has tracked changes; rendered HTML pages have
Hypothesis. Markdown — the *lingua franca* of LLM interaction — has
none of this. So reviewers fall back to writing remarks in a side file:
open a notepad, switch back and forth, copy-paste line numbers, lose
their place. The friction is high enough that most people stop after a
few comments and just tell the model to "make it better."

**Without batched feedback, every comment becomes a separate turn.**
Reviewers send the model one observation at a time as they read,
interrupting it mid-thought and re-running its context for each
fragment. The model edits a little, the user reads a little more,
sends another fragment. The conversation thrashes without ever
converging. One mistake in the model's output can also trigger a
wholesale rejection — the user discards the entire revision over a
single bad sentence and starts over, instead of pointing at the
specific line.

`LLMRedPen` tries to be the missing reviewer's chair. It renders a
Markdown file in a document-like reading view, lets you highlight any
passage or comment on any paragraph, then exports every comment as a
single block of plain text. You paste it back to the LLM in **one**
message — a real review pass, not a stream of interruptions.

The deeper goal is to keep *you*, the human, reading what the LLM
wrote.

---

## Screenshots

<table>
<tr>
<td width="50%" valign="top">

**Annotating a paragraph**

Select any text → a popup opens, the selection stays highlighted
(dashed orange) while you type, and saving turns it into a permanent
yellow mark with a matching card on the right.

![Selecting and annotating](docs/screenshots/annotation-flow.png)

</td>
<td width="50%" valign="top">

**Batch export**

Every comment, in document order, in plain text. Copy to clipboard or
save as a file — one block to paste back to your LLM.

![Export modal](docs/screenshots/export.png)

</td>
</tr>
</table>

**Editing tables in the CLAUDE.md rules file**

Tables inside the writing-rules file are typically the worst part of
Markdown editing — pipe characters, alignment hyphens, hand-counting
columns. Hover any rendered table in the rules editor to reveal an
*Edit table* button; click it to drop into a visual grid where each
cell is an auto-growing textarea. Apply turns the grid back into clean
Markdown table syntax.

![Visual table editor workflow — rules cards → markdown editor → visual table grid](docs/screenshots/table-editor.png)

---

## What it does

- **Document-style rendering.** Renders Markdown (via markdown-it) with
  math (via KaTeX) in a justified, serif, paper-like layout. When a
  file uses only `###` headings in its body (the common "outline
  draft" shape), the outline labels are hidden so the prose flows as
  it would in the published version.
- **Three annotation modes:**
  - *Text selection* — select a passage, write a comment about that
    phrase.
  - *Paragraph-level* — click the `§S ¶N` marker in the margin to
    comment on a whole paragraph without selecting any text.
  - *General note* — file-wide remark, no anchor.
- **Right-hand comments pane** — every comment as a card. Click a card
  to scroll to the passage; hover to highlight the matching mark in
  the article. Edit / delete inline.
- **Batch export** — copy all comments to clipboard or save as a plain
  text file. The output is what you paste back to the model.
- **Robust re-anchoring** — when the underlying file is edited between
  annotation sessions, a four-layer locator (modelled on the
  [Hypothesis client](https://github.com/hypothesis/client)) re-finds
  each annotation. Annotations that can't be located surface as
  *orphan* in the right pane, with one-click *Re-anchor* /
  *Convert to note* / *Delete* actions.
- **Folder restore** — the chosen paper folder is remembered across
  refreshes; one click reopens it (Chromium permissions permitting).
- **CLAUDE.md rules editor** — the one file the tool writes back to
  disk. Each `##` / `###` block is a card with edit / add / delete
  actions; the editor has a Markdown toolbar, live preview, and a
  visual editor for tables (no more hand-editing `| col | col |`).

---

## Requirements

- **Browser:** Chromium-based (Chrome / Edge / Arc / Brave). The tool
  uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
  which is not yet available in Firefox or fully in Safari.
- **Runtime:** [Bun](https://bun.sh). Only used for the tiny static
  server that serves the page — there is no backend.

---

## Install

```sh
git clone https://github.com/rqhu1995/LLMRedPen.git ~/tools/llm-redpen
```

(or clone anywhere; the paths below just assume `~/tools/llm-redpen`).

Optional shell alias — for fish:

```fish
# add to ~/.config/fish/conf.d/03-aliases.fish (or your shell config)
alias redpen='bun ~/tools/llm-redpen/server.ts'
```

---

## Usage

Start the server:

```sh
bun ~/tools/llm-redpen/server.ts
# or, with the alias:
redpen
```

Open <http://localhost:5173/> in a Chromium browser.

1. **Open a paper folder.** Click *Open paper folder…* and pick a
   directory. The viewer requires a `CLAUDE.md` at the folder's root
   (this is the writing-rules file it can edit; everything else is
   read-only). If `CLAUDE.md` is missing, the folder is rejected.
2. **Read.** The left sidebar lists every `.md` file in the folder.
   Click one to render it. Each paragraph gets a `§S ¶N` anchor in
   the margin.
3. **Annotate.** Three ways:
   - Select text → comment popup → `⌘+Enter` to save.
   - Click a `§S ¶N` margin label → comment popup pre-anchored to
     that paragraph.
   - Click *+ Add note* in the right pane → unanchored remark.
4. **Navigate.** Hover a `mark` in the article to see the comment in
   a tooltip and highlight the matching card on the right. Click
   either side to scroll the other.
5. **Export.** *Export…* in the right pane gives you the full batch as
   plain text. *Copy to clipboard* or *Save as file…* (the file picker
   defaults to your paper folder).
6. **Hand off to the LLM.** Paste the *agent prompt* (see next
   section) followed by the exported comments. One message, one
   review pass.

### Hotkeys

| Key | Action |
|---|---|
| `⌘+Enter` (in comment popup) | Save the comment |
| `Esc` | Cancel popup / close modal / cancel re-anchor mode |
| `⌘+E` | Open the export modal |
| `Tab` / `Shift+Tab` (in table editor) | Move between cells |

> Windows / Linux users: read `⌘` as `Ctrl` throughout — the UI labels
> are rewritten automatically on non-Mac platforms.

---

## Working with an LLM agent

The exported comments use anchors like `§1 ¶3` that don't exist in the
underlying Markdown source — they're computed by the viewer from
structural position. Before pasting your comments to the LLM, prepend
the *Annotation anchor format* prompt so the model knows how to map
anchors back to the file. The full prompt lives at
[`docs/agent-prompt.md`](docs/agent-prompt.md).

Workflow:

```
[Annotation anchor format prompt from docs/agent-prompt.md]

[Your exported comments block]

Please apply these comments to introduction-merged.md.
```

The model edits the source. On the next refresh of the viewer, the
four-layer re-anchoring locator finds most comments in their new
positions automatically. Anything it can't recover is shown as
*orphan*, and you decide whether to re-anchor manually, convert to a
general note, or delete.

---

## How it works

- **Browser-first.** The viewer is a static page (`index.html` +
  `app.js` + `style.css`) served by a ~50-line Bun static server
  (`server.ts`). All file I/O is client-side through the File System
  Access API. The server has no knowledge of your manuscript.
- **Persistent annotations.** Comments live in `localStorage` keyed by
  folder name. The chosen folder handle lives in `IndexedDB` so a
  refresh offers one-click reopen.
- **Robust re-anchoring.** Each annotation stores four selectors —
  structural anchor (`§S ¶N`), character offset, exact quoted text,
  and 32-character prefix / suffix — and a four-layer locator (from
  cheap-and-exact to slow-and-fuzzy) re-finds the passage after the
  file is edited:
  1. anchor + exact text (within the original paragraph),
  2. character offset + exact text (with slack),
  3. `prefix + text + suffix` (whole article, whitespace-flexible),
  4. `prefix + (anything) + suffix` (handles in-place paraphrase).
  The design follows the
  [Hypothesis client's anchoring pipeline](https://github.com/hypothesis/client/blob/main/src/annotator/anchoring/html.ts);
  the *quote with context* path is intentionally the most resilient,
  so paragraph re-orderings and most prose edits don't orphan
  comments.
- **Dependencies.** markdown-it and KaTeX from a CDN; no npm install,
  no build step. Bun is only the static file server.

---

## Known limitations

- **Same quote, same context, multiple occurrences.** If the exact
  selected text and its prefix/suffix appear at more than one place
  in the file, the locator picks the candidate closest to the stored
  character offset. Without a position hint it picks the first hit,
  which may be the wrong one. (Hypothesis has the same caveat.)
- **Whole-paragraph rewrite.** If the LLM rewrites both the quoted
  text **and** its prefix/suffix beyond recognition, the locator
  falls through to *orphan*. There is no semantic / embedding
  fallback; this is what the manual *Re-anchor* button is for.
- **Annotations live in your browser.** Clearing `localStorage` for
  `http://localhost:5173`, switching browsers, or wiping the profile
  drops them. The *Save as file…* button in the export modal is the
  intended escape hatch for portable backups.
- **Editing files other than `CLAUDE.md` is by design out of scope.**
  Use your normal Markdown editor (or have the LLM edit the file
  directly) for everything else; this tool is the reviewer's chair,
  not the author's chair.

---

## Roadmap

The tool is intentionally small. Current scope is **read → annotate →
export**, not authoring. Possible next steps:

- **A cleaner CLAUDE.md rules editor.** The current per-section
  editor with toolbar + live preview is functional but still asks the
  user to think in Markdown. A pattern library or guided forms for
  common rule types ("forbid phrase X", "always cite source Y when
  claiming Z") would help users build a rules file without thinking
  about syntax.
- **Reference corpus support.** Engineering papers have established
  conventions in their fields, but uploading ten PDFs and saying
  "match this style" rarely works — the model doesn't know what to
  extract. A workflow that slices reference PDFs by section
  (Introduction, Related Work, …), iterates with the user to
  articulate the relevant style features for each section, and
  produces a focused style guide — built up *incrementally* rather
  than dumped in one shot — is a direction worth exploring.
- **Version diff.** Snapshot the file at export time; on the next
  load, offer a word-level diff against the snapshot in a
  prose-friendly format (red strikethrough + green underline), so the
  user can see at a glance what the LLM changed.

These are sketches. The intent throughout is to stay minimal: the
tool should remove friction from review, not become another writing
environment.

---

## Project layout

```
llm-redpen/
├── server.ts         # ~50 lines, Bun static server
├── index.html        # page skeleton + modals
├── app.js            # all browser logic
├── style.css         # styles
├── favicon.svg       # red-pen-on-yellow icon
├── docs/
│   └── agent-prompt.md   # prompt explaining the §S ¶N anchor format to LLMs
└── README.md
```

---

## License

MIT.
