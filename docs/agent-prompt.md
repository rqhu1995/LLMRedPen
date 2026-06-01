# Agent prompt: annotation anchor format

Paste this block at the top of the message in which you hand a batch of
comments exported from LLMRedPen to your LLM agent, before the comments
themselves. The triple-backticked block is what the agent reads; the
surrounding text is for you, the user.

---

````
# Annotation anchor format (read first)

The comments below are exported from a Markdown/TeX reading tool that
prefixes each comment with a `§S ¶N` anchor. **These anchors are NOT
in the source file** — they are computed by the viewer from
structural position. Use this rule to locate each anchor in the file:

## Rule

1. For Markdown: a single top-level `# H1` title is **skipped** from
   section counting.
2. For Markdown, every subsequent heading (`##`, `###`, `####`, ...)
   is section-numbered in flat document order: **§1, §2, §3, ...**.
   For TeX, every `\section{...}`, `\subsection{...}`,
   `\subsubsection{...}`, `\paragraph{...}`, and
   `\subparagraph{...}` is numbered the same flat way.
3. Within each section, every paragraph / list / blockquote / code
   block / table is **¶1, ¶2, ¶3, ...** in source order. Horizontal
   rules (`---`) do not count as paragraphs. In TeX, paragraph blocks
   are contiguous prose chunks between blank lines or structural
   commands/environments.

## Example mapping for `introduction-merged.md`

```
# Introduction                          (H1, skipped)
### Background and motivation            → §1
  paragraph "Bike-sharing systems..."    → §1 ¶1
  paragraph "Daily operation..."         → §1 ¶2
  paragraph "Imbalance is not..."        → §1 ¶3
  paragraph "This paper addresses..."    → §1 ¶4
### The static BRP with broken bikes…    → §2
  paragraph "The static bike..."         → §2 ¶1
  paragraph "The basic BRP..."           → §2 ¶2
  ...
### User dissatisfaction modeling…       → §3
### Cluster-first route-second…          → §4
### Contributions and paper organisation → §5
### (and so on)
```

## Comment formats you will see

- `§S ¶N` + `> "exact quote"` + comment — comment on that quoted
  phrase inside paragraph §S ¶N. The quote may be truncated with `…`
  if it was longer than 120 chars; use the visible portion to locate.
- `§S ¶N` + comment (no `> "…"` line) — comment on paragraph §S ¶N as
  a whole, with no specific phrase picked.
- `[note]` + comment — free-form remark, not tied to any location;
  applies to the file as a whole.

## Editing notes

- You do NOT need to preserve `§N ¶N` numbering. It is a viewer-side
  display only; the viewer re-computes the numbers from the new
  structure on the next refresh.
- If a quoted phrase has already been edited away in a prior round
  and you can't find it, apply the spirit of the comment to the
  closest equivalent location and say what you did.
````

---

## Why this prompt matters

The viewer's `§S ¶N` markers don't appear in the source `.md` / `.tex` file —
they are a display convenience computed each render. Without this
prompt, an agent will often look for the literal symbols in the file,
fail to find them, and either ask the user where they are or skip the
comment entirely. With this prompt, the agent maps each anchor back to
the corresponding paragraph in the source and edits in place.

The example block uses `introduction-merged.md` because that's a common
starting Markdown case (single `# H1` title, then several `###`
subsections). For files with a different heading structure — Markdown
or TeX — the rule still holds: structural headings are flat-numbered in
document order. You can update the example block to reflect the actual
structure of your file if you want, but the rule text is enough on its
own.
