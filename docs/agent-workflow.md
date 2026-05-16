# Agent workflow setup prompt

Use this prompt **once, when bootstrapping a writing-agent session** in
which the agent will produce per-subsection drafts that the user reviews
in LLMRedPen. It establishes two conventions:

1. Where intermediate plan files go in the paper folder.
2. How draft metadata blocks must be formatted so the viewer can strip
   them from the reading view.

The annotation-anchor prompt (see [`agent-prompt.md`](agent-prompt.md))
is separate — paste that with each batch of comments you hand to the
agent. This file is the *one-time* setup.

---

````
# Workflow conventions for the writing agent

## 1. Plan files: file instead of chat

From now on, every imitation plan (the 4-part Phase 1 / Sub-step 3a
deliverable — Target / Verbatim copy / Sentence-level diff / Resulting
draft) is written to a markdown file, not to chat. Path convention:

    plans/§1.x-imitation-plan.md

For example, the §1.3 plan goes to `plans/§1.3-imitation-plan.md`. If
the `plans/` subfolder does not yet exist in the paper folder, create
it the first time you write into it.

The four-part structure stays exactly as before — just emit it into the
file instead of streaming it to chat. After writing, send a one-line
chat confirmation: file path + cite count + "ready for review".

If the author leaves comments on a plan file (they review plans the
same way they review the manuscript), treat that as a Phase-3 revision
pass on the plan: re-emit the plan file, do NOT advance to Phase 2
until they approve.

## 2. Metadata formatting constraints (viewer-imposed)

The author reviews these files in a viewer that strips draft metadata
from the reading view. It recognises three patterns:

- **HTML comments** — `<!-- ... -->` anywhere, multi-line OK. Always
  stripped.
- **Leading blockquote** — any `>`-prefixed run at the top of a file
  before the first body paragraph. Always stripped. (Mid-document
  blockquotes are kept.)
- **Self-review notes block** — a paragraph whose first token is
  literally `**Self-review notes`, followed by a bullet list. Stripped
  together as one unit until the next H3, blank-then-non-list, or
  end-of-file.

The self-review pattern is matched by literal prefix. Do NOT rename
the block to `**Internal critique:**` or `**Self-review:**` or
anything else — the viewer will fail to recognise it and the bullets
will leak into the reading view, polluting both the reading flow and
the §S ¶N paragraph numbering.

The four-part block in `introduction-draft.md` keeps its current shape:

    ### <descriptive title — no §1.x numbering>

    <prose paragraph(s)>

    **Self-review notes (C2.4 internal critic pass — surface to author):**

    - **Qualifiers (fl-001).** ...
    - ...

    <!-- §1.x status: Draft N produced YYYY-MM-DD ... -->

The changelog HTML comment at the bottom is fine — the viewer strips
that too.

## 3. Folder layout after this change

    paper/
    ├── CLAUDE.md
    ├── STYLE.md, INTRO-OUTLINE.md, exemplars.md, FEEDBACK-LEARNED.md
    ├── introduction-draft.md, introduction-merged.md    ← manuscript
    └── plans/
        ├── §1.1-imitation-plan.md
        ├── §1.2-imitation-plan.md
        ├── §1.3-imitation-plan.md
        └── ...

The viewer enumerates root `.md` files as the *Manuscript* group and
`plans/*.md` as a separate *Plans* group in its sidebar. Plan files
are annotatable and reloadable but do not participate in the
round-based diff workflow (no Proceed button, no Prev/Diff tabs).
````
