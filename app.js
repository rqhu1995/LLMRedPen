/* md-annotator — main browser logic.
 *
 * Single-folder workflow:
 *   1. User picks a folder via showDirectoryPicker(). Any folder with .md/.tex files works.
 *   2. Sidebar lists all .md/.tex files in that folder.
 *   3. Clicking a file renders it with §-section and ¶-paragraph markers.
 *   4. Selecting text opens a comment popup; comments persist in localStorage keyed by folder name.
 *   5. Export-comments modal offers clipboard copy or showSaveFilePicker (default startIn = paper folder).
 *   6. The CLAUDE.md rules editor parses CLAUDE.md into H2/H3 cards with edit / add / delete actions
 *      and writes changes back via the FSA directory handle.
 *
 * No data ever leaves the browser. The Bun server (server.ts) only serves index.html / app.js / style.css.
 */

'use strict';

// ============================== Globals ==============================

let directoryHandle = null;   // FileSystemDirectoryHandle of the paper folder
let currentFile = null;       // { name, handle, content }
let annotations = {};         // { filename: [ { anchor, text, comment, ... } ] } — current round
let baselines = {};           // { filename: { content, annotations, timestamp } } — last locked previous round
let folderFileNames = [];     // sorted list of review filenames currently in the folder

// Which tab the article pane is showing right now. Drives render paths and
// gates write operations (only the 'current' tab accepts new annotations).
//   'current' — current file content + current-round comments (editable)
//   'prev'    — previous-round snapshot + its comments (read-only)
//   'diff'    — word-level diff of previous content vs current file content
let activeTab = 'current';

// Whether to render leading-blockquote front-matter and HTML-comment
// metadata blocks. Off by default — these are author/changelog notes
// that pollute the reading view AND get counted as paragraphs in the
// §S ¶N numbering. Toggle persisted globally (not per-folder) since it's
// a personal reading preference.
let showMetadata = false;

// Index of rule IDs the reader can hover/click in plans + manuscript prose.
// Populated from `rules/` (recursive) + root `CLAUDE.md` after the folder
// is opened. Shape: Map<normalizedId, { file, heading, snippet }>.
// See buildRulesIndex / wrapRuleReferences.
let rulesIndex = new Map();

// Where the user was when they clicked a .rule-ref. Single-level history
// (a jump from B during a jump-from-A overwrites the A return state).
// Cleared on manual sidebar navigation. See captureReturnState /
// clearReturnState / jumpBack.
let returnState = null;
let mdParser = null;          // markdown-it instance
let activeSelection = null;   // { text, anchor, contextBefore, contextAfter, charOffset }
let rulesData = null;         // { handle, text, sections } while rules editor is open

// localStorage / IndexedDB keys kept as `mda:` and `mda` respectively
// (legacy from when the project was named md-annotator) so that existing
// users keep their saved annotations and folder handle after the rename
// to LLMRedPen. Do not change without a migration step.
const ANNOTATIONS_PREFIX = 'mda:';
const CONTEXT_LEN = 32;  // chars of prefix/suffix stored on new annotations
const REVIEW_EXTENSIONS = ['.md', '.tex'];

// Platform detection for cross-platform hotkey labels. Source UI strings
// use ⌘ (Mac convention); on Windows / Linux we substitute Ctrl at boot.
const IS_MAC = (() => {
  if (navigator.userAgentData?.platform) {
    return navigator.userAgentData.platform === 'macOS';
  }
  return /Mac|iPhone|iPad/.test(navigator.platform || '');
})();

// ============================== IndexedDB: directory-handle persistence ===
//
// localStorage cannot store FileSystemDirectoryHandle (it's a structured-
// cloneable host object, not JSON). IndexedDB can. We store one handle keyed
// by 'lastFolder' so that a page refresh can prompt to re-open the same
// folder with a single click, rather than navigating the directory picker
// from scratch each time.

const IDB_NAME = 'mda';
const IDB_STORE = 'handles';
const IDB_KEY = 'lastFolder';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  try {
    const db = await openIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.warn('saveHandle failed', e);
  }
}

async function loadHandle() {
  try {
    const db = await openIDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => rej(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function clearHandle() {
  try {
    const db = await openIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* ignore */ }
}

// ============================== Init =================================

async function init() {
  mdParser = window.markdownit({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });
  checkBrowserSupport();
  applyPlatformHotkeys();
  loadShowMetadata();
  updateMetadataToggleLabel();
  bindUIEvents();
  bindRuleRefHandlers();  // document-level — safe to bind before any folder is open
  await offerRestore();
}

// On non-Mac platforms, rewrite every ⌘ symbol in the static UI text
// (text nodes, title attributes, placeholders) to Ctrl+. Functional
// behaviour is already cross-platform — the keydown handlers fire on
// both `e.metaKey` and `e.ctrlKey`; this only fixes what the user reads.
function applyPlatformHotkeys() {
  if (IS_MAC) return;
  const swap = (s) => s.replace(/⌘\+?/g, 'Ctrl+');

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent.includes('⌘')) n.textContent = swap(n.textContent);
  }
  document.querySelectorAll('[title]').forEach((el) => {
    if (el.getAttribute('title').includes('⌘')) {
      el.setAttribute('title', swap(el.getAttribute('title')));
    }
  });
  document.querySelectorAll('[placeholder]').forEach((el) => {
    if (el.getAttribute('placeholder').includes('⌘')) {
      el.setAttribute('placeholder', swap(el.getAttribute('placeholder')));
    }
  });
}

function checkBrowserSupport() {
  if (typeof window.showDirectoryPicker !== 'function') {
    const w = document.getElementById('browser-warning');
    w.innerHTML = '⚠ This browser does not support the File System Access API.<br>Open this page in <strong>Chrome / Edge / Arc / Brave</strong>.';
    document.getElementById('open-folder').disabled = true;
  }
}

// ============================== Markdown + math ======================

// markdown-it can mangle math (esp. underscores). Protect $...$ and $$...$$ regions
// from markdown by placeholdering them, render markdown, then substitute KaTeX output.
function renderMarkdownWithMath(text) {
  const blocks = [];
  const PLACEHOLDER_INLINE  = (i) => `MD_MATH_I_${i}`;
  const PLACEHOLDER_DISPLAY = (i) => `MD_MATH_D_${i}`;

  // Display $$...$$ first (greedy, multi-line). Allow internal $ since [^$] is too strict.
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const i = blocks.length;
    blocks.push({ display: true, math: math.trim() });
    return PLACEHOLDER_DISPLAY(i);
  });

  // Inline $...$ — single-line, non-greedy. Don't match across newlines.
  text = text.replace(/\$([^\n$]+?)\$/g, (_, math) => {
    const i = blocks.length;
    blocks.push({ display: false, math: math.trim() });
    return PLACEHOLDER_INLINE(i);
  });

  let html = mdParser.render(text);

  // Substitute math placeholders back. Note: markdown-it may escape the  byte
  // but the placeholder string itself is intact.
  html = html.replace(/MD_MATH_(I|D)_(\d+)/g, (_, type, idxStr) => {
    const b = blocks[parseInt(idxStr)];
    try {
      return window.katex.renderToString(b.math, {
        displayMode: b.display,
        throwOnError: false,
        strict: 'ignore',
      });
    } catch (e) {
      return `<code class="math-error">$${escapeHtml(b.math)}$</code>`;
    }
  });

  return html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// =================== Metadata stripping ==============================
//
// Two patterns drafts commonly carry that aren't body prose:
//
//   1. A leading blockquote at the top of the file (a "Working draft"
//      note, version notice, etc.) before the first body paragraph.
//      It can sit before or after the H1; we tolerate either.
//   2. HTML comments anywhere — `<!-- changelog: ... -->` blocks the
//      author leaves between paragraphs. With `html: false` set on
//      markdown-it, these otherwise render as escaped text and pollute
//      both the reading view and the §S ¶N numbering.
//
// Stripping happens at source level (before markdown-it sees the text)
// so the rendered DOM has no metadata at all and the paragraph counter
// naturally skips past it.

function stripMetadata(text) {
  // (1) HTML comments — multi-line, anywhere.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // (2) Leading blockquote(s) at the top of the file.
  text = stripLeadingBlockquote(text);
  // (3) `**Self-review notes` blocks (Patch 5 v2 author convention).
  text = stripSelfReviewBlocks(text);
  return text;
}

function stripLeadingBlockquote(text) {
  // Walk lines from the top, allowing blank lines and headings to pass
  // through. The first contiguous run of `>`-prefixed lines we hit gets
  // dropped. As soon as we see a body line (anything that's neither
  // blank, heading, nor blockquote) we stop.
  const lines = text.split('\n');
  const out = [];
  let stillLeading = true;
  let i = 0;
  while (i < lines.length) {
    if (!stillLeading) { out.push(lines[i++]); continue; }
    const trimmed = lines[i].trim();
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed)) {
      out.push(lines[i++]);
      continue;
    }
    if (trimmed.startsWith('>')) {
      while (i < lines.length && lines[i].trim().startsWith('>')) i++;
      continue;
    }
    stillLeading = false;
    out.push(lines[i++]);
  }
  return out.join('\n');
}

// Self-review pattern (Patch 5 v2): a paragraph whose first non-blank line
// starts literally with `**Self-review notes`, followed (after an optional
// blank line) by a bullet list. Strip the header paragraph + the entire
// bullet list + any continuation/indented lines, until we hit non-list
// content. The literal prefix is part of the contract with the writing
// agent — see docs/agent-prompt.md.
function stripSelfReviewBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('**Self-review notes')) {
      // (a) Skip the header paragraph (up to the first blank line).
      while (i < lines.length && lines[i].trim() !== '') i++;
      // (b) Skip blank lines.
      while (i < lines.length && lines[i].trim() === '') i++;
      // (c) Skip the bullet list. Includes intra-list blank lines (if the
      //     next non-blank line is also a bullet) and indented
      //     continuation lines of bullet items.
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && /^[-*+]\s/.test(lines[j].trim())) {
            i = j;
            continue;
          }
          break;  // blank then non-bullet → end of list
        }
        if (/^[-*+]\s/.test(trimmed)) { i++; continue; }
        if (/^\s+\S/.test(lines[i])) { i++; continue; }  // continuation
        break;
      }
      continue;
    }
    out.push(lines[i++]);
  }
  return out.join('\n');
}

function loadShowMetadata() {
  try { showMetadata = localStorage.getItem(ANNOTATIONS_PREFIX + 'showMetadata') === 'true'; }
  catch (e) { showMetadata = false; }
}

function persistShowMetadata() {
  try { localStorage.setItem(ANNOTATIONS_PREFIX + 'showMetadata', showMetadata ? 'true' : 'false'); }
  catch (e) { /* ignore */ }
}

function toggleShowMetadata() {
  showMetadata = !showMetadata;
  persistShowMetadata();
  updateMetadataToggleLabel();
  if (currentFile) renderActiveTab();
}

function updateMetadataToggleLabel() {
  const btn = document.getElementById('toggle-metadata');
  if (!btn) return;
  btn.textContent = showMetadata ? '✓ Metadata shown' : 'Show metadata';
  btn.classList.toggle('active', showMetadata);
  btn.setAttribute('aria-pressed', showMetadata ? 'true' : 'false');
}

// =================== Rules cross-reference ===========================
//
// Plans and manuscript prose constantly cite rule IDs — fl-001, B3.1,
// §1.3, Exemplar 2 — defined elsewhere in the project. Looking each one
// up in the source file kills the reading flow. We build a lightweight
// index of every recognisable ID once at folder-open time, then wrap
// every match in the rendered article as a hoverable <a.rule-ref>.
// Hover → tooltip with the heading + body snippet. Click → switch to
// the source file and scroll to that heading.
//
// Matching is exact (with one normalisation: fl-N → fl-NNN zero-pad).
// No fuzzy partial matching in this version — if an ID isn't in the
// index, the text is left untouched.

// Patterns we recognise inside body prose, ordered: more specific first.
const RULE_ID_PATTERNS = [
  { re: /\bfl-\d{1,3}\b/g,                  kind: 'fl' },
  { re: /§\d+(?:\.\d+)+/g,                  kind: 'section' },
  { re: /\bExemplar\s+\d+\b/g,              kind: 'exemplar' },
  { re: /\b[A-D]\d+(?:\.\d+)*\b/g,          kind: 'claude' },  // A1, B3.1, C2.4, D5
];

function normalizeRuleId(raw, kind) {
  if (kind === 'fl') {
    const m = raw.match(/^fl-(\d+)$/);
    return m ? 'fl-' + m[1].padStart(3, '0') : raw;
  }
  if (kind === 'exemplar') {
    return raw.replace(/\s+/g, ' ');  // "Exemplar 1"
  }
  return raw;
}

// Patterns we recognise *in heading text* of rules files, to harvest
// the IDs that index the body content following each heading. Returns
// the array of all IDs the heading carries (a heading may have more
// than one, e.g. "### §1.3 — Broken bikes (B3.1 applies)").
function harvestHeadingIds(headingText) {
  const ids = [];
  for (const { re, kind } of RULE_ID_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(headingText))) {
      ids.push(normalizeRuleId(m[0], kind));
    }
  }
  // De-dupe while preserving order.
  return [...new Set(ids)];
}

// Walk every rules-bearing .md file under the open folder, parse headings,
// snapshot the body that follows each heading as a snippet. Idempotent;
// safe to call again on reload.
async function buildRulesIndex() {
  rulesIndex = new Map();
  if (!directoryHandle) return;

  // Candidate files: CLAUDE.md at root + everything under rules/ recursively.
  const candidates = [];
  try {
    await directoryHandle.getFileHandle('CLAUDE.md');
    candidates.push('CLAUDE.md');
  } catch (e) { /* CLAUDE.md absent, fine */ }
  try {
    const rulesHandle = await directoryHandle.getDirectoryHandle('rules');
    const found = await collectMdRecursively(rulesHandle, 'rules', 1);
    candidates.push(...found);
  } catch (e) { /* rules/ absent, fine */ }

  for (const path of candidates) {
    try {
      const handle = await resolveFileHandle(path);
      const file = await handle.getFile();
      const text = await file.text();
      indexHeadings(text, path);
    } catch (e) {
      console.warn('[redpen] rules-index read failed for', path, e);
    }
  }
}

function indexHeadings(text, file) {
  const lines = text.split('\n');
  let current = null;  // { heading, ids, bodyLines }
  const flush = () => {
    if (!current || !current.ids.length) return;
    // First ~5 non-empty body lines, capped at ~500 chars for the snippet.
    const snippetLines = [];
    let chars = 0;
    for (const line of current.bodyLines) {
      if (!line.trim()) {
        if (snippetLines.length) snippetLines.push(line);
        continue;
      }
      snippetLines.push(line);
      chars += line.length;
      if (snippetLines.filter(l => l.trim()).length >= 6 || chars > 500) break;
    }
    const snippet = snippetLines.join('\n').trim();
    for (const id of current.ids) {
      // First definition wins. If the same ID appears in two files,
      // we keep the earliest enumerated source — predictable enough.
      if (!rulesIndex.has(id)) {
        rulesIndex.set(id, { file, heading: current.heading, snippet });
      }
    }
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      flush();
      current = { heading: h[2], ids: harvestHeadingIds(h[2]), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();
}

// Walk the rendered article's text nodes; wrap every recognised rule
// reference in <a.rule-ref data-ref-key="...">. Skips nodes inside
// code, pre, existing links, and annotation marks so we don't double-
// wrap or break copy/paste of code samples.
const WRAP_SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'MARK', 'SCRIPT', 'STYLE']);

function wrapRuleReferences(rootEl) {
  if (!rootEl || !rulesIndex.size) return;

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (WRAP_SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  for (const textNode of targets) {
    const text = textNode.textContent;
    // Quick reject: no plausible ID character → skip cheap.
    if (!/(fl-|§|Exemplar|[A-D]\d)/.test(text)) continue;

    // Collect every match across all patterns, dedupe by position.
    const hits = [];
    for (const { re, kind } of RULE_ID_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const id = normalizeRuleId(m[0], kind);
        if (!rulesIndex.has(id)) continue;
        hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], id });
      }
    }
    if (!hits.length) continue;

    // Sort by position; resolve overlaps by preferring the longer match.
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const pruned = [];
    let cursor = -1;
    for (const h of hits) {
      if (h.start < cursor) continue;  // overlaps previous, drop
      pruned.push(h);
      cursor = h.end;
    }

    // Splice text node into [text, <a>, text, <a>, …, text] children.
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const h of pruned) {
      if (h.start > last) frag.appendChild(document.createTextNode(text.slice(last, h.start)));
      const a = document.createElement('a');
      a.className = 'rule-ref';
      a.href = '#';
      a.dataset.refKey = h.id;
      a.textContent = h.raw;
      frag.appendChild(a);
      last = h.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// ===== Tooltip + click navigation =====

let ruleTooltipTimer = null;
let ruleRefDocBound = false;

// Document-level delegation so refs work the same whether they appear
// inside #rendered (Current / Prev tabs) or inside the Diff tab's
// self-review panel. Idempotent.
function bindRuleRefHandlers() {
  if (ruleRefDocBound) return;
  ruleRefDocBound = true;

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest('a.rule-ref');
    if (!a) return;
    clearTimeout(ruleTooltipTimer);
    ruleTooltipTimer = setTimeout(() => showRuleTooltip(a), 100);
  });
  document.addEventListener('mouseout', (e) => {
    const a = e.target.closest && e.target.closest('a.rule-ref');
    if (!a) return;
    clearTimeout(ruleTooltipTimer);
    hideRuleTooltip();
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.rule-ref');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    jumpToRuleSource(a.dataset.refKey);
  });
}

function showRuleTooltip(refEl) {
  const key = refEl.dataset.refKey;
  const entry = rulesIndex.get(key);
  if (!entry) return;
  const tip = document.getElementById('rule-tooltip');
  if (!tip) return;
  tip.querySelector('.rt-source').textContent = `${entry.file} — click to open`;
  tip.querySelector('.rt-heading').textContent = entry.heading;
  tip.querySelector('.rt-body').textContent = entry.snippet || '(no body snippet)';

  // Position below the ref; flip above if it would clip the viewport.
  tip.hidden = false;
  const rect = refEl.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  if (top + tipRect.height > window.scrollY + window.innerHeight - 20) {
    top = rect.top + window.scrollY - tipRect.height - 6;
  }
  const maxLeft = window.innerWidth - tipRect.width - 16;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideRuleTooltip() {
  const tip = document.getElementById('rule-tooltip');
  if (tip) tip.hidden = true;
}

async function jumpToRuleSource(key) {
  const entry = rulesIndex.get(key);
  if (!entry) return;
  hideRuleTooltip();

  // Snapshot where we are BEFORE we move, so the "← Back" button can
  // restore exactly this state. Capture happens even for same-file
  // jumps (the heading might be far from the current scroll position).
  captureReturnState();

  if (!currentFile || currentFile.name !== entry.file) {
    try {
      await openFile(entry.file, { isJump: true });
    } catch (e) {
      alert('Could not open ' + entry.file + ': ' + e.message);
      clearReturnState();
      return;
    }
  }

  // Scroll to the first heading whose text contains the target heading
  // text. Headings live at H1–H6 in #rendered; we match by exact text
  // since headings are typically unique by ID.
  const rendered = document.getElementById('rendered');
  const target = Array.from(rendered.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .find((h) => h.textContent.trim() === entry.heading.trim());
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('rule-jump-flash');
    void target.offsetWidth;
    target.classList.add('rule-jump-flash');
    setTimeout(() => target.classList.remove('rule-jump-flash'), 1400);
  }
}

// ===== Return-state stack (single level) =====

function captureReturnState() {
  if (!currentFile) return;
  returnState = {
    file: currentFile.name,
    tab: activeTab,
    scrollY: document.getElementById('content').scrollTop,
  };
  updateJumpBackButton();
}

function clearReturnState() {
  if (!returnState) return;
  returnState = null;
  updateJumpBackButton();
}

function updateJumpBackButton() {
  const btn = document.getElementById('jump-back');
  if (!btn) return;
  if (returnState) {
    // Show just the leaf so the button stays narrow; full path lives
    // in the title attribute.
    const leaf = returnState.file.split('/').pop();
    btn.textContent = '← Back to ' + leaf;
    btn.title = `Return to ${returnState.file} at the position you left it`;
    btn.hidden = false;
  } else {
    btn.hidden = true;
  }
}

async function jumpBack() {
  if (!returnState) return;
  const target = returnState;
  returnState = null;  // clear up-front so openFile's isJump:false path
                       // doesn't try to re-clear via clearReturnState
  if (!currentFile || currentFile.name !== target.file) {
    try {
      await openFile(target.file, { isJump: true });
    } catch (e) {
      alert('Could not return to ' + target.file + ': ' + e.message);
      updateJumpBackButton();
      return;
    }
  }
  if (target.tab && target.tab !== activeTab) {
    setActiveTab(target.tab);
  }
  // Restore scroll after the render settles. setActiveTab is sync but
  // smooth scrolling already won; a microtask defer keeps it crisp.
  await Promise.resolve();
  document.getElementById('content').scrollTop = target.scrollY;
  updateJumpBackButton();
}

// ============================== Folder picker ========================

// On page load, look up the last-used directory handle and surface a
// "Reopen 'name'" affordance. Browsers require a user gesture to re-grant
// the FS permission, so we never auto-load: we only adjust the button text
// to make a one-click restore obvious.
async function offerRestore() {
  if (!window.showDirectoryPicker) return;
  const handle = await loadHandle();
  if (!handle) return;

  const btn = document.getElementById('open-folder');

  // Sometimes the permission survives across reloads. If it does, we can
  // silently restore the folder without any user gesture.
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      await applyFolder(handle);
      return;
    }
  } catch (e) { /* fall through to manual reopen */ }

  btn.textContent = `Reopen "${handle.name}"`;
  btn.savedHandle = handle;
}

async function openFolder() {
  const btn = document.getElementById('open-folder');
  let handle = null;

  // If a previously-used handle is staged, try to re-grant on it first.
  if (btn.savedHandle) {
    try {
      const perm = await btn.savedHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') handle = btn.savedHandle;
    } catch (e) { /* swallow */ }
    btn.savedHandle = null;
    btn.textContent = 'Open paper folder…';
  }

  // Otherwise fall through to the picker.
  if (!handle) {
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      return; // user cancelled
    }
  }

  await applyFolder(handle);
}

async function applyFolder(handle) {
  // Any folder with .md/.tex files is acceptable. The viewer used to require
  // CLAUDE.md at the root (because the rules editor needed it as its
  // source of truth) but the editor now creates the file on demand if
  // it's missing, so the gate is gone.
  directoryHandle = handle;
  await saveHandle(handle);

  const nameEl = document.getElementById('folder-name');
  nameEl.textContent = handle.name;
  nameEl.title = handle.name;

  await listFiles();
  loadAnnotations();
  loadBaselines();
  renderStrandedSidebar();
  // Build the cross-reference index in the background — it's I/O bound
  // and the user can start reading before it finishes. Tooltips just
  // won't fire until the index is populated.
  buildRulesIndex().catch((e) => console.warn('[redpen] buildRulesIndex failed', e));

  document.getElementById('export-comments').disabled = false;
  document.getElementById('clear-comments').disabled = false;
  document.getElementById('open-rules-editor').disabled = false;
  document.getElementById('comments-pane').hidden = false;

  renderCommentsList();

  // Auto-reopen the last file the user was looking at, if it still exists.
  // Removes the "now I have to find the file again" friction after a
  // browser refresh (the folder restores silently when its FS permission
  // survives; the file should follow).
  const last = loadLastOpenedFile();
  if (last && folderFileNames.includes(last)) {
    try { await openFile(last); }
    catch (e) { console.warn('[redpen] auto-reopen of last file failed', e); }
  }
}

// Files that get the FULL round model (Prev / Diff / Current + Proceed)
// vs. half-treatment (annotatable + reloadable, but no rounds).
//
// Full:
//   - Any .md/.tex at the folder root
//   - Anything under a `manuscript/` subfolder — common layout where
//     the user keeps the draft itself in its own subfolder for tidiness
//
// Half:
//   - Files under any other subfolder (plans/, rules/, self-review/, …)
//
// If your project uses a different name for the manuscript subfolder,
// add it to MANUSCRIPT_FOLDERS below.
const MANUSCRIPT_FOLDERS = new Set(['manuscript']);  // case-insensitive

function isReviewFileName(name) {
  const lower = (name || '').toLowerCase();
  return REVIEW_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function fileFormatForName(name) {
  const lower = (name || '').toLowerCase();
  return lower.endsWith('.tex') ? 'tex' : 'markdown';
}

function isSubfolderFile(name) {
  if (typeof name !== 'string' || !name.includes('/')) return false;
  const top = name.split('/')[0].toLowerCase();
  if (MANUSCRIPT_FOLDERS.has(top)) return false;
  return true;
}
// Back-compat alias — older helpers (and the writing-agent docs) still
// reach for isPlanFile. Same semantics now: it means "half-treatment".
function isPlanFile(name) { return isSubfolderFile(name); }

function prettyGroupName(slug) {
  // "self-review" → "Self-review", "rules" → "Rules", "plans" → "Plans".
  // Just title-case the first letter; preserve hyphens / underscores so
  // the user's folder name reads back unchanged.
  if (!slug) return slug;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// Max recursion depth inside a top-level subfolder. Plenty for the
// manuscript/plans/ + paper-style layouts the tool was built for;
// keeps the sidebar from exploding if someone aims it at a deeply
// nested tree like a node_modules sibling that crept past the filter.
const MAX_SUBFOLDER_DEPTH = 4;

// Folders that never belong in the review sidebar — build / reference
// material that isn't review-worthy prose. Case-insensitive. Edit here
// if your project uses different conventions.
const IGNORED_FOLDERS = new Set([
  'node_modules',
  'docs',     // user-side reference docs, not manuscript prose
  'latex',    // build output / LaTeX scaffolding
  'archive',  // historical snapshots — clutter inside e.g. rules/archive/
]);

function shouldSkipFolder(name) {
  return name.startsWith('.') || IGNORED_FOLDERS.has(name.toLowerCase());
}

async function collectMdRecursively(dirHandle, prefix, depth) {
  const out = [];
  if (depth > MAX_SUBFOLDER_DEPTH) return out;
  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'file' && name.endsWith('.md')) {
        out.push(prefix + '/' + name);
      } else if (entry.kind === 'directory') {
        if (shouldSkipFolder(name)) continue;
        const nested = await collectMdRecursively(entry, prefix + '/' + name, depth + 1);
        out.push(...nested);
      }
    }
  } catch (e) {
    console.warn('[redpen] subfolder enumeration failed at', prefix, e);
  }
  return out;
}

async function collectReviewFilesRecursively(dirHandle, prefix, depth) {
  const out = [];
  if (depth > MAX_SUBFOLDER_DEPTH) return out;
  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'file' && isReviewFileName(name)) {
        out.push(prefix + '/' + name);
      } else if (entry.kind === 'directory') {
        if (shouldSkipFolder(name)) continue;
        const nested = await collectReviewFilesRecursively(entry, prefix + '/' + name, depth + 1);
        out.push(...nested);
      }
    }
  } catch (e) {
    console.warn('[redpen] subfolder enumeration failed at', prefix, e);
  }
  return out;
}

async function listFiles() {
  // (1) Root .md/.tex files — the round-model manuscript.
  const rootFiles = [];
  // (2) Subfolders → { folderName: [pathPrefixedFileNames] }
  //     Each value contains every supported review file found at any depth inside that
  //     top-level subfolder (e.g. manuscript/plans/foo.md is bucketed
  //     under "manuscript", with its full relative path preserved).
  const subgroups = {};

  for await (const [name, entry] of directoryHandle.entries()) {
    if (entry.kind === 'file' && isReviewFileName(name)) {
      rootFiles.push(name);
    } else if (entry.kind === 'directory') {
      if (shouldSkipFolder(name)) continue;
      const subFiles = await collectReviewFilesRecursively(entry, name, 1);
      if (subFiles.length) {
        subFiles.sort((a, b) => a.localeCompare(b));
        subgroups[name] = subFiles;
      }
    }
  }
  rootFiles.sort((a, b) => a.localeCompare(b));

  // Flat list used by stranded-rename detection + folder-file lookups.
  folderFileNames = rootFiles.concat(...Object.values(subgroups));

  const list = document.getElementById('file-list');
  list.innerHTML = '';

  // Root label: "Manuscript" by default (back-compat with the common
  // case where the manuscript lives at root) but switch to "Top level"
  // when the folder actually contains a sibling `manuscript/` subfolder
  // — otherwise the sidebar would show two identical "Manuscript"
  // headings, one for the root group and one for the subfolder.
  const rootLabel = ('manuscript' in subgroups) ? 'Top level' : 'Manuscript';
  appendFileGroup(list, rootLabel, rootFiles);

  // Then each subfolder, alphabetically. Each gets the title-cased
  // folder name as its group label; nested review files show their path
  // relative to the group prefix.
  for (const folder of Object.keys(subgroups).sort()) {
    appendFileGroup(list, prettyGroupName(folder), subgroups[folder], {
      subfolder: true,
      prefix: folder,
    });
  }

  renderStrandedSidebar();
}

function appendFileGroup(parent, label, names, opts) {
  opts = opts || {};
  const heading = document.createElement('h3');
  heading.className = 'file-group-title';
  heading.textContent = label;
  parent.appendChild(heading);
  for (const name of names) {
    const a = document.createElement('a');
    a.href = '#';
    // .subfolder is a *treatment* signal, not a *grouping* signal: it
    // tracks isSubfolderFile so a `manuscript/foo.md` file (round-
    // model treatment) reads the same colour as a root file, while
    // `plans/foo.md` and `rules/foo.md` stay muted.
    a.className = 'file-link' + (isSubfolderFile(name) ? ' subfolder' : '');
    a.textContent = opts.subfolder
      ? name.slice(opts.prefix.length + 1)  // strip the group prefix
      : name;
    a.dataset.filename = name;
    a.title = name;
    a.onclick = (e) => { e.preventDefault(); openFile(name); };
    parent.appendChild(a);
  }
}

// Annotation buckets whose key isn't in the current folder file list — most
// commonly because the user renamed the file outside the app. We surface
// them in the sidebar so the user can reassign or delete instead of
// silently losing comments.
function renderStrandedSidebar() {
  const section = document.getElementById('stranded-section');
  const list = document.getElementById('stranded-list');
  if (!list) return;

  const folderSet = new Set(folderFileNames);
  const stranded = Object.keys(annotations)
    .filter((name) => !folderSet.has(name) && (annotations[name] || []).length)
    .sort((a, b) => a.localeCompare(b));

  if (!stranded.length) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }

  section.hidden = false;
  list.innerHTML = '';
  for (const name of stranded) {
    list.appendChild(buildStrandedItem(name));
  }
}

function buildStrandedItem(oldName) {
  const item = document.createElement('div');
  item.className = 'stranded-item';
  item.dataset.key = oldName;

  const row = document.createElement('div');
  row.className = 'stranded-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'stranded-name';
  nameEl.textContent = oldName;
  nameEl.title = oldName;

  const countEl = document.createElement('span');
  countEl.className = 'stranded-count';
  countEl.textContent = String((annotations[oldName] || []).length);

  const reassignBtn = document.createElement('button');
  reassignBtn.className = 'stranded-reassign';
  reassignBtn.textContent = 'Reassign…';
  reassignBtn.onclick = () => {
    const picker = item.querySelector('.stranded-picker');
    picker.hidden = !picker.hidden;
  };

  row.append(nameEl, countEl, reassignBtn);
  item.appendChild(row);

  const picker = document.createElement('div');
  picker.className = 'stranded-picker';
  picker.hidden = true;

  const select = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— pick target file —';
  select.appendChild(placeholder);
  for (const name of folderFileNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (currentFile && currentFile.name === name) opt.selected = true;
    select.appendChild(opt);
  }

  const migrateBtn = document.createElement('button');
  migrateBtn.textContent = 'Migrate';
  migrateBtn.className = 'primary';
  migrateBtn.onclick = () => {
    const target = select.value;
    if (!target) return;
    migrateBucket(oldName, target);
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => { picker.hidden = true; };

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.className = 'danger';
  deleteBtn.onclick = () => {
    if (!confirm(`Delete ${(annotations[oldName] || []).length} annotation(s) for "${oldName}"?\n\nThis cannot be undone.`)) return;
    delete annotations[oldName];
    persistAnnotations();
    renderStrandedSidebar();
  };

  picker.append(select, migrateBtn, cancelBtn, deleteBtn);
  item.appendChild(picker);

  return item;
}

function migrateBucket(from, to) {
  const src = annotations[from] || [];
  if (!src.length) return;
  const dst = annotations[to] || [];
  // Append; preserve original timestamps so the locator and right-pane
  // sort still work coherently.
  annotations[to] = dst.concat(src);
  delete annotations[from];
  persistAnnotations();
  renderStrandedSidebar();
  // If the user is currently on the target file, refresh highlights + cards.
  if (currentFile && currentFile.name === to) {
    refreshAnnotationsUI();
  }
}

// ============================== File rendering =======================

// Resolve a possibly-prefixed file name ("foo.md", "plans/foo.md",
// "rules/section/foo.md") to the matching FileSystemFileHandle. Walks
// each path segment as a directory handle in turn.
async function resolveFileHandle(name) {
  const parts = name.split('/');
  const leaf = parts.pop();
  let h = directoryHandle;
  for (const part of parts) {
    h = await h.getDirectoryHandle(part);
  }
  return h.getFileHandle(leaf);
}

async function openFile(name, opts) {
  opts = opts || {};
  const handle = await resolveFileHandle(name);
  const file = await handle.getFile();
  const text = await file.text();
  currentFile = { name, handle, content: text };
  persistLastOpenedFile(name);
  // Manual navigation (sidebar click) cancels any pending return state —
  // the user has deliberately moved on; the "← Back" affordance would
  // mislead them. Rule-ref jumps pass {isJump: true} to preserve it.
  if (!opts.isJump) clearReturnState();

  document.querySelectorAll('.file-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.filename === name);
  });

  document.getElementById('welcome').hidden = true;
  document.getElementById('tab-bar').hidden = false;

  // Default to the Current tab on every file open. The Current view is
  // the only one that's always meaningful (the file is on disk).
  activeTab = 'current';
  refreshTabAvailability();
  renderActiveTab();

  // Scroll to top of newly opened file.
  document.getElementById('content').scrollTop = 0;
}

// =============================== Tab plumbing ========================
//
// Three tabs, all operate on the currently-open file:
//   prev    : the version + comments locked at the end of the previous
//             round (read-only). Disabled when no baseline exists.
//   diff    : word-level diff between the previous version and the
//             current file content. Disabled when no baseline exists.
//   current : the current file content + this round's in-progress comments
//             (the only tab that accepts new annotations).

function getDisplayContent() {
  if (!currentFile) return '';
  if (activeTab === 'prev') {
    const b = baselines[currentFile.name];
    return b ? b.content : '';
  }
  return currentFile.content;
}

function getDisplayAnnotations() {
  if (!currentFile) return [];
  if (activeTab === 'prev') {
    const b = baselines[currentFile.name];
    return b ? (b.annotations || []) : [];
  }
  return annotations[currentFile.name] || [];
}

// Whether the active tab accepts user edits (new annotations, edit, delete,
// promote). Only Current is interactive; Prev is a frozen snapshot, Diff
// has no annotation surface at all.
function isInteractiveTab() {
  return activeTab === 'current';
}

function setActiveTab(name) {
  if (!currentFile) return;
  if (name === activeTab) return;
  if (isPlanFile(currentFile.name) && name !== 'current') return;  // plans are Current-only
  if (name === 'prev' || name === 'diff') {
    if (!baselines[currentFile.name]) return;  // disabled
  }
  activeTab = name;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  renderActiveTab();
}

function refreshTabAvailability() {
  const plan = !!(currentFile && isPlanFile(currentFile.name));
  const hasBaseline = !!(currentFile && baselines[currentFile.name]);

  // Plan files don't participate in the round model: hide Prev / Diff
  // buttons entirely and force activeTab back to Current. The tab bar
  // itself stays visible so Reload / Show metadata still have a home.
  const tabBar = document.getElementById('tab-bar');
  tabBar.classList.toggle('plan-file', plan);
  if (plan) activeTab = 'current';

  document.querySelectorAll('.tab-btn').forEach((b) => {
    if (b.dataset.tab === 'prev' || b.dataset.tab === 'diff') {
      b.disabled = !hasBaseline;
    }
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });

  // Allow promote whenever a manuscript file is on Current. Plan files
  // never offer Proceed because their rounds aren't a thing.
  const proceed = document.getElementById('proceed-next-round');
  proceed.disabled = plan || !isInteractiveTab();
}

// Renders whatever the active tab needs into the article container (or the
// dedicated diff container). Replaces the old inline body of openFile().
function renderActiveTab() {
  const rendered = document.getElementById('rendered');
  const diffView = document.getElementById('diff-view');

  if (activeTab === 'diff') {
    rendered.hidden = true;
    diffView.hidden = false;
    document.getElementById('comments-pane').classList.add('diff-hidden');
    renderDiffTab();
    return;
  }

  // Both 'current' and 'prev' render markdown into #rendered; the only
  // difference is which content + which annotation bucket they use.
  diffView.hidden = true;
  rendered.hidden = false;
  document.getElementById('comments-pane').classList.remove('diff-hidden');

  const rawContent = getDisplayContent();
  const format = currentFile ? fileFormatForName(currentFile.name) : 'markdown';
  const renderText = (format === 'markdown' && !showMetadata)
    ? stripMetadata(rawContent)
    : rawContent;
  renderFileContent(rendered, renderText, format);
  // Wrap rule-ID references before highlights — the locator just reads
  // textContent, which is unchanged by the <a> wrapping.
  wrapRuleReferences(rendered);
  refreshAnnotationsUI();

  // Toggle the article into a read-only visual state on Prev so the user
  // gets a hint that selection won't do anything useful here.
  rendered.classList.toggle('read-only', !isInteractiveTab());

  // The 'add general note' button only makes sense on the editable tab.
  document.getElementById('add-general-note').disabled = !isInteractiveTab();
}

function renderFileContent(rendered, text, format) {
  if (format === 'tex') {
    renderTeXWithAnchors(rendered, text);
    return;
  }
  rendered.innerHTML = renderMarkdownWithMath(text);
  numberSectionsAndParagraphs(rendered);
}

function renderTeXWithAnchors(rendered, text) {
  rendered.classList.remove('rendered--outline-h3');
  rendered.innerHTML = '';
  const blocks = parseTeXBlocks(text);
  const frag = document.createDocumentFragment();
  for (const block of blocks) {
    let el = null;
    if (block.type === 'heading') {
      el = document.createElement(`h${Math.min(6, Math.max(2, block.level))}`);
      el.textContent = block.text;
    } else if (block.type === 'code') {
      el = document.createElement('pre');
      el.textContent = block.text;
    } else {
      el = document.createElement('p');
      el.textContent = block.text;
    }
    frag.appendChild(el);
  }
  rendered.appendChild(frag);
  numberSectionsAndParagraphs(rendered);
}

function parseTeXBlocks(text) {
  const blocks = [];
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
  const headingRe = /^\\(section|subsection|subsubsection|paragraph|subparagraph)\*?\{(.+)\}\s*$/;
  const envStartRe = /^\\begin\{([^}]+)\}\s*$/;
  const envEndRe = /^\\end\{([^}]+)\}\s*$/;
  const headingLevel = {
    section: 2,
    subsection: 3,
    subsubsection: 4,
    paragraph: 5,
    subparagraph: 6,
  };

  let para = [];
  let env = null;
  let envLines = [];

  const flushPara = () => {
    if (!para.length) return;
    const body = para.join(' ').trim();
    if (body) blocks.push({ type: 'paragraph', text: body });
    para = [];
  };

  const flushEnv = () => {
    if (!env) return;
    const body = envLines.join('\n').trim();
    if (body) blocks.push({ type: 'code', text: body });
    env = null;
    envLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    const trimmed = line.trim();

    if (env) {
      envLines.push(line);
      const end = trimmed.match(envEndRe);
      if (end && end[1] === env) flushEnv();
      continue;
    }

    if (!trimmed) {
      flushPara();
      continue;
    }

    if (trimmed.startsWith('%')) continue;

    const headingMatch = trimmed.match(headingRe);
    if (headingMatch) {
      flushPara();
      blocks.push({
        type: 'heading',
        level: headingLevel[headingMatch[1]] || 2,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    const envMatch = trimmed.match(envStartRe);
    if (envMatch) {
      flushPara();
      env = envMatch[1];
      envLines = [line];
      continue;
    }

    para.push(trimmed);
  }

  flushPara();
  flushEnv();
  return blocks;
}

function numberSectionsAndParagraphs(rendered) {
  const children = Array.from(rendered.children);

  // If there's exactly one H1, treat it as a file title and skip from section counting.
  const h1Count = children.filter((el) => el.tagName === 'H1').length;
  const h2Count = children.filter((el) => el.tagName === 'H2').length;
  const h3Count = children.filter((el) => el.tagName === 'H3').length;
  const skipH1 = h1Count === 1;

  // Outline mode: a file using only H3 in its body (no H2) is treated as
  // having outline-style subsection labels that should be hidden so the
  // rendered prose reads as continuous text. CSS hides H3 + HR in this
  // mode; the JS still tags H3s with §-numbers so paragraph anchors remain
  // correct.
  rendered.classList.toggle('rendered--outline-h3', h2Count === 0 && h3Count > 0);

  let sectionIdx = 0;
  let paraIdx = 0;
  let inSection = false;

  for (const child of children) {
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = parseInt(tag.charAt(1));
      if (level === 1 && skipH1) continue;
      sectionIdx++;
      paraIdx = 0;
      inSection = true;
      child.dataset.section = `§${sectionIdx}`;
    } else if (isBlockContent(child)) {
      if (inSection) {
        paraIdx++;
        const anchorText = `§${sectionIdx} ¶${paraIdx}`;
        child.dataset.anchor = anchorText;

        // Insert a clickable label in the left margin. Click → add a
        // paragraph-level note for this block without needing to select
        // any text. Position is absolute relative to the paragraph (which
        // is position:relative). user-select:none keeps the label out of
        // any text selection the user makes inside the paragraph.
        const label = document.createElement('span');
        label.className = 'anchor-label';
        label.dataset.anchor = anchorText;
        label.title = 'Click to comment on this paragraph';
        label.textContent = anchorText;
        child.insertBefore(label, child.firstChild);
      } else {
        // Pre-section content (e.g. metadata): no anchor, no marker.
        child.dataset.anchor = '';
      }
    }
  }
}

function isBlockContent(el) {
  return ['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE'].includes(el.tagName);
}

// (findFlexibleMatch was here; replaced by findInRange + findByContext
//  in the 4-layer locator above.)

// ============================== Selection / comment popup ============

function bindSelectionHandlers() {
  const rendered = document.getElementById('rendered');
  rendered.addEventListener('mouseup', handleSelection);
}

function handleSelection(e) {
  // Selection-driven new annotations are only valid on the editable Current
  // tab. The Prev tab is a frozen archive of last round's snapshot.
  if (!isInteractiveTab()) return;

  // If clicking on existing mark, show its comment instead of opening a new popup.
  if (e.target.closest('mark.annotation')) {
    return;
  }

  const sel = window.getSelection();
  const text = sel.toString();

  if (!text || !text.trim() || !sel.rangeCount) {
    return;
  }

  const range = sel.getRangeAt(0);

  // Only allow comments inside the rendered article.
  const rendered = document.getElementById('rendered');
  if (!rendered.contains(range.commonAncestorContainer)) {
    return;
  }

  const anchorEl = findAnchorElement(range.startContainer);
  if (!anchorEl || !anchorEl.dataset.anchor) {
    return; // not in an anchored block (preamble)
  }

  activeSelection = {
    type: 'anchored',
    // Trim leading/trailing whitespace from the selection so what we
    // store, search for, and export is exactly what the user meant.
    text: text.trim(),
    anchor: anchorEl.dataset.anchor,
    contextBefore: textBefore(range, anchorEl, CONTEXT_LEN),
    contextAfter: textAfter(range, anchorEl, CONTEXT_LEN),
    // Character offset of the selection's start in the article's
    // flattened text (used as a layer-2 / layer-3 hint when the
    // anchor or text drifts after a file edit).
    charOffset: computeArticleCharOffset(range),
  };

  showCommentPopup(range.getBoundingClientRect(), range);
}

// Open the comment popup *without* a text selection. Used for structural
// or document-level notes that aren't tied to a specific passage.
function addGeneralNote() {
  if (!currentFile) return;
  if (!isInteractiveTab()) return;
  hideCommentPopup();  // close any open popup first
  activeSelection = {
    type: 'general',
    text: '',
    anchor: '_general',
    contextBefore: '',
    contextAfter: '',
  };
  showCommentPopup(null, null);
}

// Open the comment popup for a paragraph-level note: anchor is the
// clicked paragraph (§S ¶N) but no text is quoted. Used when the user
// wants to comment on a whole paragraph without dragging a selection.
function addParagraphNote(anchor) {
  if (!currentFile) return;
  if (!isInteractiveTab()) return;
  hideCommentPopup();  // close any open popup first

  const rendered = document.getElementById('rendered');
  const block = Array.from(rendered.querySelectorAll('[data-anchor]'))
    .find((el) => el.dataset.anchor === anchor);
  if (!block) return;

  block.classList.add('pending-paragraph');

  activeSelection = {
    type: 'anchored',
    text: '',
    anchor: anchor,
    contextBefore: '',
    contextAfter: '',
  };

  showCommentPopup(block.getBoundingClientRect(), null);
}

function findAnchorElement(node) {
  while (node) {
    if (node.dataset && node.dataset.anchor !== undefined && node.dataset.anchor !== '') {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function textBefore(range, anchorEl, n) {
  const r = document.createRange();
  r.setStart(anchorEl, 0);
  r.setEnd(range.startContainer, range.startOffset);
  const s = r.toString();
  return s.slice(Math.max(0, s.length - n));
}

function textAfter(range, anchorEl, n) {
  const r = document.createRange();
  r.setStart(range.endContainer, range.endOffset);
  // Move to end of anchor element
  r.setEndAfter(anchorEl);
  return r.toString().slice(0, n);
}

// Range captured at popup-open time, applied as a persistent
// .pending-annotation mark only once the user engages with the popup
// (clicks into it / focuses the textarea). Until then, the user's native
// browser selection stays alive so they can Cmd+C the text they just
// highlighted instead of annotating it. See the focusin handler in
// bindUIEvents.
let pendingRangeForPopup = null;

// Show the comment popup. Two independent parameters:
//   positionRect — DOMRect-like ({top, bottom, left, right}) for where to
//                  anchor the popup on screen. null = center on viewport.
//   pendingRange — Range that may be wrapped in a transient
//                  <mark.pending-annotation> for visual feedback once the
//                  user engages with the popup. null = no pending mark
//                  (used for general notes and paragraph-level notes).
function showCommentPopup(positionRect, pendingRange) {
  const popup = document.getElementById('comment-popup');
  const popupHeight = 180;
  const popupWidth = 320;

  let top, left;
  if (positionRect) {
    top = positionRect.bottom + window.scrollY + 8;
    left = positionRect.left + window.scrollX;
    if (top + popupHeight > window.scrollY + window.innerHeight) {
      top = positionRect.top + window.scrollY - popupHeight - 8;
    }
    if (left + popupWidth + 16 > window.innerWidth) {
      left = window.innerWidth - popupWidth - 16;
    }
  } else {
    // Centered (general notes).
    top = window.scrollY + Math.max(100, (window.innerHeight - popupHeight) / 2);
    left = (window.innerWidth - popupWidth) / 2;
  }

  popup.style.top = Math.max(8, top) + 'px';
  popup.style.left = Math.max(8, left) + 'px';

  // Store the range; defer wrapping until commitPendingHighlight() runs
  // on first user engagement with the popup. Wrapping eagerly would
  // collapse the user's native selection (extractContents mutates the
  // DOM), breaking Cmd+C if they meant to copy rather than annotate.
  pendingRangeForPopup = pendingRange || null;

  const label =
    activeSelection.type === 'general' ? '— note (not anchored)' :
    !activeSelection.text             ? activeSelection.anchor + ' — whole paragraph' :
                                        activeSelection.anchor;
  document.getElementById('comment-anchor-display').textContent = label;

  const ta = document.getElementById('comment-text');
  ta.value = '';
  popup.hidden = false;
  // NOTE: deliberately no ta.focus() here. Auto-focus would steal the
  // browser selection (the textarea becoming focused collapses the
  // native selection in the article), making it impossible to Cmd+C
  // the text you just highlighted. The user picks: click into the
  // textarea to type a comment, or Cmd+C right now to copy.
}

// Called the first time the user engages with the popup (focusin on any
// of its controls). Promotes the deferred pending highlight so the
// commented passage stays visually marked while they type, even after
// the native selection collapses on textarea focus.
function commitPendingHighlight() {
  if (!pendingRangeForPopup) return;
  applyPendingHighlight(pendingRangeForPopup);
  pendingRangeForPopup = null;
}

// Wrap the current selection's range in a transient <mark> that visually
// persists through the comment-writing workflow. Mirror of highlightOne's
// DOM logic but with a different class and no event binding.
function applyPendingHighlight(range) {
  if (!range || range.collapsed) return null;
  const mark = document.createElement('mark');
  mark.className = 'pending-annotation';
  try {
    if (range.startContainer === range.endContainer) {
      range.surroundContents(mark);
    } else {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
    return mark;
  } catch (e) {
    return null;
  }
}

// Unwrap any pending highlights, leaving the underlying text intact.
// Called on save (so the permanent .annotation mark can replace them
// cleanly) and on cancel (so the article returns to its original state).
function clearPendingHighlights() {
  const rendered = document.getElementById('rendered');
  if (!rendered) return;
  rendered.querySelectorAll('mark.pending-annotation').forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  rendered.querySelectorAll('.pending-paragraph').forEach((el) => {
    el.classList.remove('pending-paragraph');
  });
  rendered.normalize();
}

function hideCommentPopup() {
  clearPendingHighlights();
  document.getElementById('comment-popup').hidden = true;
  activeSelection = null;
  pendingRangeForPopup = null;
  // Don't clear the browser selection — the user may have just dismissed
  // the popup specifically because they wanted to copy the highlighted
  // text instead.
}

function saveComment() {
  if (!activeSelection || !currentFile) return;
  const comment = document.getElementById('comment-text').value.trim();
  if (!comment) {
    hideCommentPopup();
    return;
  }

  const fname = currentFile.name;
  if (!annotations[fname]) annotations[fname] = [];

  annotations[fname].push({
    type: activeSelection.type || 'anchored',
    text: activeSelection.text,
    anchor: activeSelection.anchor,
    contextBefore: activeSelection.contextBefore,
    contextAfter: activeSelection.contextAfter,
    charOffset: activeSelection.charOffset,
    comment: comment,
    timestamp: Date.now(),
  });

  // Strip the pending highlight before re-rendering, so the permanent
  // <mark class="annotation"> replaces it cleanly (no nested marks).
  clearPendingHighlights();

  persistAnnotations();
  refreshAnnotationsUI();
  hideCommentPopup();
  window.getSelection().removeAllRanges();
}

// ============================== Annotation storage ===================

function annotationsKey() {
  return ANNOTATIONS_PREFIX + (directoryHandle ? directoryHandle.name : 'default');
}

function baselinesKey() {
  return ANNOTATIONS_PREFIX + 'baselines:' + (directoryHandle ? directoryHandle.name : 'default');
}

function lastFileKey() {
  return ANNOTATIONS_PREFIX + 'lastFile:' + (directoryHandle ? directoryHandle.name : 'default');
}

function persistLastOpenedFile(name) {
  try { localStorage.setItem(lastFileKey(), name); } catch (e) { /* ignore */ }
}

function loadLastOpenedFile() {
  try { return localStorage.getItem(lastFileKey()); } catch (e) { return null; }
}

function persistAnnotations() {
  try {
    localStorage.setItem(annotationsKey(), JSON.stringify(annotations));
  } catch (e) {
    alert('localStorage write failed (quota?). Comment kept in memory only for this session.');
  }
}

function loadAnnotations() {
  try {
    const raw = localStorage.getItem(annotationsKey());
    annotations = raw ? JSON.parse(raw) : {};
  } catch (e) {
    annotations = {};
  }
}

function persistBaselines() {
  try {
    localStorage.setItem(baselinesKey(), JSON.stringify(baselines));
  } catch (e) {
    // Baselines can be large (full file content); a quota miss here is
    // worth flagging, but we don't want to lose the in-memory copy.
    alert('localStorage write failed for previous-round snapshot (quota?). The snapshot is held in memory for this session only.');
  }
}

function loadBaselines() {
  try {
    const raw = localStorage.getItem(baselinesKey());
    baselines = raw ? JSON.parse(raw) : {};
  } catch (e) {
    baselines = {};
  }
}

// ============================== Highlight rendering ==================

function applyExistingHighlights() {
  if (!currentFile) return;

  // Remove all existing marks first.
  const rendered = document.getElementById('rendered');
  rendered.querySelectorAll('mark.annotation').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  rendered.normalize();

  // Only anchored comments get article highlights; general notes have no text.
  // The 4-layer locator (see highlightOne / locateAnnotation) needs the
  // current article text map fresh each call because successful highlights
  // mutate the DOM by wrapping text in <mark> elements.
  for (const ann of getDisplayAnnotations()) {
    if (ann.type === 'general') continue;
    highlightOne(ann);
  }
}

// 4-layer annotation locator + highlighter. Modelled on the Hypothesis
// client (https://github.com/hypothesis/client) anchoring pipeline.
// Used internally to draw highlights for annotations created against the
// current file content. If an annotation cannot be located (e.g. user
// edited the .md mid-session and the surrounding text drifted) we just
// silently skip the highlight; the comment card still shows in the right
// pane with its stored anchor + quote so the user can still see what
// they wrote.
function highlightOne(ann) {
  if (!ann.text) return;

  const article = document.getElementById('rendered');
  const map = buildTextMap(article);

  const loc = locateAnnotation(ann, map, article);
  if (!loc) return;

  const range = offsetsToRange(map, loc.start, loc.end);
  if (!range) return;

  const mark = document.createElement('mark');
  mark.className = 'annotation';
  mark.dataset.annId = String(ann.timestamp);
  try {
    if (range.startContainer === range.endContainer) {
      range.surroundContents(mark);
    } else {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
  } catch (err) {
    console.warn('[redpen] highlightOne wrap failed', err);
    return;
  }

  bindMarkHover(mark, ann);
}

function locateAnnotation(ann, map, articleEl) {
  const text = map.combined;

  // Layer 1: structural anchor scoped to its block.
  if (ann.anchor && !ann.anchor.startsWith('_')) {
    const bounds = getBlockBounds(map, articleEl, ann.anchor);
    if (bounds) {
      const m = findInRange(text, bounds.start, bounds.end, ann.text);
      if (m) return m;
    }
  }

  // Layer 2: positional hint (charOffset stored on newer annotations).
  if (typeof ann.charOffset === 'number') {
    const m = findAtOffset(text, ann.charOffset, ann.text);
    if (m) return m;
  }

  // Layer 3: exact `prefix + text + suffix` across the whole article.
  const m3 = findByContext(text, ann, /*fuzzyMiddle=*/false);
  if (m3) return m3;

  // Layer 4: `prefix + ANYTHING + suffix` — handles in-place paraphrase.
  const m4 = findByContext(text, ann, /*fuzzyMiddle=*/true);
  if (m4) return m4;

  return null;
}

// === Text-map utilities ===

// Walk every text node under `rootNode` in document order, producing a
// flat string of their concatenated content plus an offset table mapping
// `combined` positions back to (node, offsetInNode). Pulls text from
// inside existing <mark> elements too, which is what makes nested
// annotations possible.
function buildTextMap(rootNode) {
  const nodes = [];
  let combined = '';
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: combined.length });
    combined += n.textContent;
  }
  return { nodes, combined };
}

// Snap a [start, end] interval in `map.combined` back to a DOM Range.
function offsetsToRange(map, start, end) {
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;
  for (const item of map.nodes) {
    const itemEnd = item.start + item.node.textContent.length;
    if (startNode === null && start >= item.start && start <= itemEnd) {
      startNode = item.node;
      startOffset = start - item.start;
    }
    if (end > item.start && end <= itemEnd) {
      endNode = item.node;
      endOffset = end - item.start;
      break;
    }
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

// Find the [start, end] of the block carrying `data-anchor === anchorStr`
// inside `map.combined`. Used to scope layer 1's search.
function getBlockBounds(map, articleEl, anchorStr) {
  const block = Array.from(articleEl.querySelectorAll('[data-anchor]'))
    .find((el) => el.dataset.anchor === anchorStr);
  if (!block) return null;
  let lo = -1, hi = -1;
  for (const item of map.nodes) {
    if (block.contains(item.node)) {
      if (lo === -1) lo = item.start;
      hi = item.start + item.node.textContent.length;
    }
  }
  if (lo === -1) return null;
  return { start: lo, end: hi };
}

// Compute the character offset of `range.start` inside the article's
// flattened text. Called at selection time to capture a positional hint
// alongside the text quote.
function computeArticleCharOffset(range) {
  const article = document.getElementById('rendered');
  if (!article.contains(range.startContainer)) return null;
  const r = document.createRange();
  r.setStart(article, 0);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString().length;
}

// === Whitespace-flexible search primitives ===

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match `needle` against `text` where every run of whitespace in `needle`
// matches any run of whitespace (including zero) in `text`. The zero case
// matters at paragraph boundaries — rendered DOM concatenates adjacent
// paragraphs' text content with no separator, so a stored prefix that
// ended at a paragraph break still needs to match.
function buildFlexPattern(s) {
  return escapeForRegex(s).replace(/\s+/g, '\\s*');
}

function findInRange(text, lo, hi, needle) {
  const trimmed = needle.trim();
  if (!trimmed) return null;
  let re;
  try { re = new RegExp(buildFlexPattern(trimmed)); }
  catch (e) { return null; }
  const sub = text.slice(lo, hi);
  const m = sub.match(re);
  if (!m) return null;
  return { start: lo + m.index, end: lo + m.index + m[0].length };
}

function findAtOffset(text, offset, needle) {
  const trimmed = needle.trim();
  if (!trimmed) return null;
  const slack = Math.max(8, Math.floor(needle.length / 4));
  const lo = Math.max(0, offset - slack);
  const hi = Math.min(text.length, offset + needle.length + slack);
  return findInRange(text, lo, hi, trimmed);
}

// Layers 3 / 4 — context match. When `fuzzyMiddle` is false, look for
// `prefix + text + suffix` literally. When true, look for `prefix +
// (anything up to 3× text.length) + suffix` — this catches in-place
// paraphrase: the original quote is gone but the surrounding context
// survived. Among multiple candidates, the one closest to the stored
// charOffset wins.
function findByContext(text, ann, fuzzyMiddle) {
  const pre = (ann.contextBefore || '').trim();
  const suf = (ann.contextAfter || '').trim();

  if (fuzzyMiddle && (!pre || !suf)) return null;
  if (!fuzzyMiddle && !pre && !suf) return null;

  let mid;
  if (fuzzyMiddle) {
    const maxMid = Math.max(80, ann.text.length * 3);
    mid = '([\\s\\S]{1,' + maxMid + '}?)';
  } else {
    mid = '(' + buildFlexPattern(ann.text) + ')';
  }

  let pattern;
  if (pre && suf)      pattern = buildFlexPattern(pre) + mid + buildFlexPattern(suf);
  else if (pre)        pattern = buildFlexPattern(pre) + mid;
  else                 pattern = mid + buildFlexPattern(suf);

  let re;
  try { re = new RegExp(pattern, 'gd'); }
  catch (e) { return null; }

  const cands = [];
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 10000) {
    if (m.indices && m.indices[1]) {
      const [s, e] = m.indices[1];
      if (e > s) cands.push({ start: s, end: e });
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (!cands.length) return null;

  if (typeof ann.charOffset === 'number') {
    cands.sort((a, b) =>
      Math.abs(a.start - ann.charOffset) - Math.abs(b.start - ann.charOffset)
    );
  }
  return cands[0];
}

// Bidirectional hover coupling. Hovering a mark in the article highlights
// the matching card in the right pane (and shows a styled tooltip with
// the comment text); hovering a card highlights the corresponding mark.
// Both sides use the same `.mark-active` / `.card-active` classes so the
// "active" look is identical regardless of which side initiated the hover.

function bindMarkHover(mark, ann) {
  const id = String(ann.timestamp);
  mark.addEventListener('mouseenter', () => {
    showMarkTooltip(mark, ann);
    activateCardByAnnId(id);
  });
  mark.addEventListener('mouseleave', () => {
    hideMarkTooltip();
    deactivateCardByAnnId(id);
  });
}

function bindCardHover(card, ann) {
  const id = String(ann.timestamp);
  card.addEventListener('mouseenter', () => activateMarkByAnnId(id));
  card.addEventListener('mouseleave', () => deactivateMarkByAnnId(id));
}

function activateCardByAnnId(id) {
  const c = document.querySelector(`.comment-card[data-ann-id="${id}"]`);
  if (c) c.classList.add('card-active');
}
function deactivateCardByAnnId(id) {
  const c = document.querySelector(`.comment-card[data-ann-id="${id}"]`);
  if (c) c.classList.remove('card-active');
}
function activateMarkByAnnId(id) {
  const m = document.querySelector(`#rendered mark.annotation[data-ann-id="${id}"]`);
  if (m) m.classList.add('mark-active');
}
function deactivateMarkByAnnId(id) {
  const m = document.querySelector(`#rendered mark.annotation[data-ann-id="${id}"]`);
  if (m) m.classList.remove('mark-active');
}

let tooltipShowTimer = null;

function showMarkTooltip(mark, ann) {
  clearTimeout(tooltipShowTimer);
  tooltipShowTimer = setTimeout(() => {
    const tt = document.getElementById('mark-tooltip');
    tt.querySelector('.tt-anchor').textContent = ann.anchor;
    tt.querySelector('.tt-body').textContent = ann.comment;

    // Measure with hidden=false but offscreen so we know dimensions.
    tt.style.top = '-9999px';
    tt.style.left = '-9999px';
    tt.hidden = false;

    const rect = mark.getBoundingClientRect();
    const ttRect = tt.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 6;
    let left = rect.left + window.scrollX;

    if (left + ttRect.width > window.scrollX + window.innerWidth - 16) {
      left = window.scrollX + window.innerWidth - ttRect.width - 16;
    }
    if (top + ttRect.height > window.scrollY + window.innerHeight - 16) {
      top = rect.top + window.scrollY - ttRect.height - 6;
    }

    tt.style.top = Math.max(8 + window.scrollY, top) + 'px';
    tt.style.left = Math.max(8, left) + 'px';
  }, 180);
}

function hideMarkTooltip() {
  clearTimeout(tooltipShowTimer);
  document.getElementById('mark-tooltip').hidden = true;
}

// ============================== Export ===============================

function buildExportText(scope) {
  let files;
  if (scope === 'current') {
    if (!currentFile || !(annotations[currentFile.name] || []).length) {
      return '(no annotations on this file yet)';
    }
    files = [currentFile.name];
  } else {
    files = Object.keys(annotations).filter((f) => (annotations[f] || []).length).sort();
    if (!files.length) return '(no annotations yet)';
  }

  const out = [];
  for (const fname of files) {
    out.push(`=== ${fname} ===`);
    out.push('');
    const anns = [...annotations[fname]].sort(compareByAnchor);
    for (const ann of anns) {
      if (ann.type === 'general') {
        out.push('[note]');
        out.push(ann.comment);
      } else if (!ann.text) {
        // Paragraph-level annotation: anchor only, no quote.
        out.push(ann.anchor);
        out.push(ann.comment);
      } else {
        out.push(ann.anchor);
        out.push(`> "${ann.text}"`);
        out.push(ann.comment);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function getExportScope() {
  const checked = document.querySelector('input[name="export-scope"]:checked');
  return checked ? checked.value : (currentFile ? 'current' : 'all');
}

function scopeHasAnnotations(scope) {
  if (scope === 'current') {
    return !!(currentFile && (annotations[currentFile.name] || []).length);
  }
  return Object.keys(annotations).some((f) => (annotations[f] || []).length);
}

function compareByAnchor(a, b) {
  // Sort order: general notes first (no anchor to sort by), then anchored
  // comments by §S ¶N, then by creation time as the tiebreaker.
  const aGen = a.type === 'general';
  const bGen = b.type === 'general';
  if (aGen && !bGen) return -1;
  if (!aGen && bGen) return 1;
  if (aGen && bGen) return a.timestamp - b.timestamp;
  const pa = parseAnchor(a.anchor);
  const pb = parseAnchor(b.anchor);
  return pa.section - pb.section || pa.para - pb.para || a.timestamp - b.timestamp;
}

function parseAnchor(s) {
  const m = /§(\d+)\s*¶(\d+)/.exec(s);
  if (m) return { section: parseInt(m[1]), para: parseInt(m[2]) };
  const m2 = /¶(\d+)/.exec(s);
  if (m2) return { section: 0, para: parseInt(m2[1]) };
  return { section: 0, para: 0 };
}

function showExportModal() {
  // Default scope: current file if one is open, else all.
  const radios = document.querySelectorAll('input[name="export-scope"]');
  const currentRadio = document.querySelector('input[name="export-scope"][value="current"]');
  const nameSpan = document.getElementById('export-scope-current-name');

  if (currentFile) {
    currentRadio.disabled = false;
    currentRadio.checked = true;
    nameSpan.textContent = `(${currentFile.name})`;
  } else {
    currentRadio.disabled = true;
    currentRadio.checked = false;
    document.querySelector('input[name="export-scope"][value="all"]').checked = true;
    nameSpan.textContent = '(no file open)';
  }

  // Re-render on scope change.
  for (const r of radios) r.onchange = () => { renderExportList(); };
  renderExportList();
  document.getElementById('export-modal').hidden = false;
}

function renderExportList() {
  document.getElementById('export-text').textContent = buildExportText(getExportScope());
}

async function copyToClipboard() {
  const scope = getExportScope();
  if (!scopeHasAnnotations(scope)) {
    alert('Nothing to copy — no comments in scope.');
    return;
  }
  const text = buildExportText(scope);
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    alert('Copy failed: ' + e.message);
    return;
  }
  await flashExportAndAdvance('copy-clipboard', 'Copied', scope);
}

async function saveAsFile() {
  if (!directoryHandle) return;
  const scope = getExportScope();
  if (!scopeHasAnnotations(scope)) {
    alert('Nothing to save — no comments in scope.');
    return;
  }
  const text = buildExportText(scope);
  const base = (scope === 'current' && currentFile)
    ? currentFile.name.replace(/\.(md|tex)$/i, '').replace(/\//g, '-')
    : directoryHandle.name;
  const suggested = `${base}-comments.txt`;

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      startIn: directoryHandle,
      types: [{
        description: 'Plain text',
        accept: { 'text/plain': ['.txt', '.md', '.tex'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Save failed: ' + e.message);
    return;
  }
  await flashExportAndAdvance('save-file', 'Saved', scope);
}

// Shared post-action: promote everything in scope, then update the
// button to confirm both the export AND the round advance, and refresh
// the modal preview so the user can see annotations are gone.
async function flashExportAndAdvance(btnId, verb, scope) {
  const promoted = await silentPromoteScope(scope);
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const orig = btn.dataset.label || btn.textContent;
  btn.dataset.label = orig;
  btn.textContent = promoted.length > 0
    ? `${verb} & advanced ✓ (${promoted.length} file${promoted.length > 1 ? 's' : ''})`
    : `${verb} ✓`;
  setTimeout(() => { btn.textContent = btn.dataset.label || orig; }, 2200);
  // Re-render the preview so the now-empty annotation buckets are visible.
  if (!document.getElementById('export-modal').hidden) renderExportList();
}

// ============================== Clear comments modal ================
//
// Deletion lives in its own modal — pulled out of Export so the user can't
// confuse "send my work to the agent" with "destroy my work". The scope
// radio shows real comment counts so the consequence of clicking Delete
// is unambiguous.

function showClearCommentsModal() {
  const modal = document.getElementById('clear-comments-modal');
  const fileRadio = modal.querySelector('input[value="current"]');
  const allRadio = modal.querySelector('input[value="all"]');

  const currentName = currentFile ? currentFile.name : null;
  const currentCount = currentName ? (annotations[currentName] || []).length : 0;
  const allCount = Object.values(annotations).reduce((n, arr) => n + (arr ? arr.length : 0), 0);

  document.getElementById('clear-scope-current-name').textContent =
    currentName ? `"${currentName}"` : 'this file';
  document.getElementById('clear-scope-current-count').textContent =
    currentName ? `(${currentCount} comment${currentCount === 1 ? '' : 's'})` : '(no file open)';
  document.getElementById('clear-scope-all-count').textContent =
    `(${allCount} comment${allCount === 1 ? '' : 's'})`;

  // If no file is open, "this file" is meaningless — flip to all.
  if (!currentName) {
    fileRadio.disabled = true;
    allRadio.checked = true;
  } else {
    fileRadio.disabled = false;
    fileRadio.checked = true;
  }

  modal.hidden = false;
}

function hideClearCommentsModal() {
  document.getElementById('clear-comments-modal').hidden = true;
}

function confirmClearComments() {
  const scope = document.querySelector('input[name="clear-scope"]:checked').value;
  if (scope === 'current' && currentFile) {
    delete annotations[currentFile.name];
  } else if (scope === 'all') {
    annotations = {};
  } else {
    return;
  }
  persistAnnotations();
  refreshAnnotationsUI();
  renderStrandedSidebar();
  // If the export modal happens to be open behind this one, keep its
  // preview in sync.
  if (!document.getElementById('export-modal').hidden) renderExportList();
  hideClearCommentsModal();
}

// ============================== Right pane: comments list ============

function refreshAnnotationsUI() {
  applyExistingHighlights();
  renderCommentsList();
}

function renderCommentsList() {
  const list = document.getElementById('comments-list');
  const count = document.getElementById('comments-count');

  if (!currentFile) {
    list.innerHTML = '<p class="empty">Open a file to see its comments.</p>';
    count.textContent = '';
    return;
  }

  const anns = getDisplayAnnotations().slice().sort(compareByAnchor);
  const isReadOnly = !isInteractiveTab();
  count.textContent = anns.length ? `${anns.length}` : '';

  if (!anns.length) {
    list.innerHTML = isReadOnly
      ? '<p class="empty">No comments were saved in the previous round.</p>'
      : '<p class="empty">No comments on this file yet.<br>Select text in the article to add one.</p>';
    return;
  }

  list.innerHTML = '';
  for (const ann of anns) {
    list.appendChild(buildCommentCard(ann, { readOnly: isReadOnly }));
  }
}

function buildCommentCard(ann, opts) {
  opts = opts || {};
  const isGeneral = ann.type === 'general';
  const readOnly = !!opts.readOnly;

  const card = document.createElement('div');
  card.className = 'comment-card'
    + (isGeneral ? ' general' : '')
    + (readOnly ? ' read-only' : '');
  card.dataset.annId = String(ann.timestamp);

  const header = document.createElement('div');
  header.className = 'comment-card-header';

  const anchor = document.createElement('span');
  anchor.className = 'comment-anchor';
  anchor.textContent = isGeneral ? 'note' : ann.anchor;
  header.appendChild(anchor);

  // Edit / Delete buttons only on the editable Current tab. On the Prev
  // tab the cards are a frozen archive — read-only by design.
  if (!readOnly) {
    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = (e) => { e.stopPropagation(); editComment(ann.timestamp); };
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteComment(ann.timestamp); };
    actions.appendChild(delBtn);

    header.appendChild(actions);
  }

  card.appendChild(header);

  // Anchored comments with quoted text show the passage. General notes
  // and paragraph-level (no-text) anchored notes skip the quote block.
  if (!isGeneral && ann.text) {
    const quote = document.createElement('div');
    quote.className = 'comment-quote';
    quote.textContent = ann.text.length > 120 ? ann.text.slice(0, 120) + '…' : ann.text;
    card.appendChild(quote);
  }

  const body = document.createElement('div');
  body.className = 'comment-body';
  body.textContent = ann.comment;
  card.appendChild(body);

  if (!isGeneral) {
    card.addEventListener('click', () => scrollToAnchor(ann));
    bindCardHover(card, ann);
  }

  return card;
}

function scrollToAnchor(ann) {
  const rendered = document.getElementById('rendered');

  // Try the stored anchor first (the fast path for fresh annotations).
  let block = Array.from(rendered.querySelectorAll('[data-anchor]'))
    .find((el) => el.dataset.anchor === ann.anchor);

  // Fallback for stale anchors: if the §S ¶N block no longer exists at
  // the stored label (paragraphs renumbered, document restructured, or
  // metadata-hidden mode shifts §1 ¶3 → §1 ¶2), find the actual mark
  // in the article and scroll to wherever it landed.
  const mark = rendered.querySelector(`mark.annotation[data-ann-id="${ann.timestamp}"]`);
  if (!block && mark) {
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.style.transition = 'background 0.25s ease';
    const orig = mark.style.background;
    mark.style.background = 'var(--highlight-hover)';
    setTimeout(() => { mark.style.background = orig; }, 900);
    return;
  }
  if (!block) return;

  block.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Flash the matching mark for text-selection annotations, or the whole
  // paragraph for paragraph-level (no-text) annotations.
  if (mark) {
    mark.style.transition = 'background 0.25s ease';
    const orig = mark.style.background;
    mark.style.background = 'var(--highlight-hover)';
    setTimeout(() => { mark.style.background = orig; }, 900);
  } else {
    block.classList.remove('paragraph-flash');
    void block.offsetWidth;  // force reflow to restart the animation
    block.classList.add('paragraph-flash');
    setTimeout(() => block.classList.remove('paragraph-flash'), 1200);
  }
}

function deleteComment(timestamp) {
  if (!currentFile) return;
  const fname = currentFile.name;
  const ann = (annotations[fname] || []).find((a) => a.timestamp === timestamp);
  if (!ann) return;
  if (!confirm(`Delete this comment?\n\n${ann.anchor}\n"${ann.text}"\n— ${ann.comment}`)) return;
  annotations[fname] = annotations[fname].filter((a) => a.timestamp !== timestamp);
  persistAnnotations();
  refreshAnnotationsUI();
}

function editComment(timestamp) {
  if (!currentFile) return;
  const fname = currentFile.name;
  const ann = (annotations[fname] || []).find((a) => a.timestamp === timestamp);
  if (!ann) return;

  const card = document.querySelector(`.comment-card[data-ann-id="${timestamp}"]`);
  if (!card) return;
  card.classList.add('editing');

  // Swap the body for a textarea.
  const body = card.querySelector('.comment-body');
  const ta = document.createElement('textarea');
  ta.className = 'comment-edit-area';
  ta.value = ann.comment;
  body.replaceWith(ta);

  // Swap Edit/Delete for Save/Cancel.
  const actions = card.querySelector('.comment-actions');
  actions.innerHTML = '';

  const finish = (commit) => {
    if (commit) {
      const newText = ta.value.trim();
      if (newText) {
        ann.comment = newText;
        persistAnnotations();
      }
    }
    refreshAnnotationsUI();
  };

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.className = 'primary';
  saveBtn.onclick = (e) => { e.stopPropagation(); finish(true); };
  actions.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = (e) => { e.stopPropagation(); finish(false); };
  actions.appendChild(cancelBtn);

  ta.focus();
  ta.select();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener('click', (e) => e.stopPropagation());
}

// ============================== CLAUDE.md rules editor ===============

async function openRulesEditor() {
  if (!directoryHandle) return;
  let handle;
  try {
    handle = await directoryHandle.getFileHandle('CLAUDE.md');
  } catch (e) {
    if (!confirm(`No CLAUDE.md found in "${directoryHandle.name}".\n\nCreate one now? The editor will open empty; nothing is written to disk until you save.`)) return;
    try {
      handle = await directoryHandle.getFileHandle('CLAUDE.md', { create: true });
    } catch (err) {
      alert('Could not create CLAUDE.md: ' + err.message);
      return;
    }
  }
  const file = await handle.getFile();
  const text = await file.text();
  rulesData = {
    handle,
    text,
    sections: parseClaudeMd(text),
  };
  renderRulesEditor();
  document.getElementById('rules-modal').hidden = false;
}

function hideRulesEditor() {
  document.getElementById('rules-modal').hidden = true;
  rulesData = null;
}

function parseClaudeMd(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Don't parse headings inside fenced code blocks.
    if (/^```/.test(line)) inCodeBlock = !inCodeBlock;
    if (inCodeBlock) {
      if (current) current.bodyLines.push(line);
      continue;
    }

    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);

    if (h2 || h3) {
      if (current) {
        current.endLine = i - 1;
        sections.push(current);
      }
      current = {
        level: h2 ? 2 : 3,
        heading: (h2 || h3)[1],
        startLine: i,
        bodyLines: [],
      };
    } else if (h1) {
      // Title — ignore.
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    current.endLine = lines.length - 1;
    sections.push(current);
  }
  return sections;
}

function renderRulesEditor() {
  const list = document.getElementById('rules-list');
  list.innerHTML = '';

  rulesData.sections.forEach((sec, idx) => {
    const card = document.createElement('div');
    card.className = `rules-card level-${sec.level}`;

    const header = document.createElement('div');
    header.className = 'rules-card-header';

    const title = document.createElement('div');
    title.className = 'rules-card-title';
    title.innerHTML = `<span class="level-tag">H${sec.level}</span> ${escapeHtml(sec.heading)}`;
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'rules-card-actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => editSection(idx);
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.onclick = () => deleteSection(idx);
    actions.appendChild(delBtn);

    if (sec.level === 2) {
      const subBtn = document.createElement('button');
      subBtn.textContent = '+ Sub';
      subBtn.onclick = () => addSubsection(idx);
      actions.appendChild(subBtn);
    }

    header.appendChild(actions);
    card.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'rules-card-preview';
    preview.innerHTML = renderMarkdownWithMath(sec.bodyLines.join('\n'));
    card.appendChild(preview);

    list.appendChild(card);
  });

  const addTop = document.createElement('button');
  addTop.id = 'add-top-section';
  addTop.textContent = '+ New top-level section';
  addTop.onclick = () => addTopSection();
  list.appendChild(addTop);
}

function editSection(idx) {
  const sec = rulesData.sections[idx];
  const prefix = '#'.repeat(sec.level);
  const initial = `${prefix} ${sec.heading}\n${sec.bodyLines.join('\n')}`;
  openInlineEditor(initial, async (newText) => {
    if (newText === null) return;
    await replaceSectionRange(idx, idx, newText);
  });
}

function deleteSection(idx) {
  const sec = rulesData.sections[idx];
  if (!confirm(`Delete this section?\n\n  H${sec.level}: ${sec.heading}\n\n(Its body will be removed from CLAUDE.md.)`)) return;
  replaceSectionRange(idx, idx, '');
}

function addSubsection(parentIdx) {
  // Insert after the last H3 child of this H2 (or right after the H2 if it has none).
  let insertAfter = parentIdx;
  for (let i = parentIdx + 1; i < rulesData.sections.length; i++) {
    if (rulesData.sections[i].level <= 2) break;
    insertAfter = i;
  }
  const initial = `### New subsection\n\nContent…`;
  openInlineEditor(initial, async (newText) => {
    if (newText === null) return;
    await insertSectionAfter(insertAfter, newText);
  });
}

function addTopSection() {
  // Insert before any final "Out of scope" section, else append.
  let insertAfter = rulesData.sections.length - 1;
  for (let i = rulesData.sections.length - 1; i >= 0; i--) {
    if (/out of scope/i.test(rulesData.sections[i].heading)) {
      insertAfter = i - 1;
      break;
    }
  }
  const initial = `## New top-level section\n\nContent…`;
  openInlineEditor(initial, async (newText) => {
    if (newText === null) return;
    await insertSectionAfter(insertAfter, newText);
  });
}

async function replaceSectionRange(startIdx, endIdx, newBlockText) {
  const startSec = rulesData.sections[startIdx];
  const endSec = rulesData.sections[endIdx];
  const lines = rulesData.text.split('\n');
  const before = lines.slice(0, startSec.startLine);
  const after = lines.slice(endSec.endLine + 1);

  let merged;
  if (newBlockText === '') {
    merged = [...before, ...after];
  } else {
    merged = [...before, ...newBlockText.split('\n'), ...after];
  }
  await writeClaude(merged.join('\n'));
}

async function insertSectionAfter(afterIdx, newBlockText) {
  const lines = rulesData.text.split('\n');
  let insertAt;
  if (afterIdx < 0) {
    insertAt = 0;
  } else {
    insertAt = rulesData.sections[afterIdx].endLine + 1;
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const newLines = ['', ...newBlockText.split('\n'), ''];
  await writeClaude([...before, ...newLines, ...after].join('\n'));
}

async function writeClaude(newText) {
  const writable = await rulesData.handle.createWritable();
  await writable.write(newText);
  await writable.close();
  rulesData.text = newText;
  rulesData.sections = parseClaudeMd(newText);
  renderRulesEditor();
}

// ============================== Inline editor (textarea + preview) ===

function openInlineEditor(initialText, callback) {
  const overlay = document.getElementById('inline-editor');
  const ta = document.getElementById('inline-editor-text');
  const preview = document.getElementById('inline-editor-preview');

  ta.value = initialText;
  refreshPreview();

  function refreshPreview() {
    preview.innerHTML = renderMarkdownWithMath(ta.value);
    attachPreviewTableHandlers(preview, ta);
  }

  const onInput = () => refreshPreview();
  ta.oninput = onInput;

  // Markdown-formatting keyboard shortcuts inside the textarea.
  const onTaKeydown = (e) => {
    // ⌘+Enter and Esc are handled globally below to avoid double-binding.
    if (e.metaKey || e.ctrlKey) {
      const map = { b: 'bold', i: 'italic', '`': 'code', k: 'link' };
      const action = map[e.key.toLowerCase()];
      if (action) {
        e.preventDefault();
        applyMdAction(action);
        return;
      }
    }
    // Smart list / quote continuation on Enter.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handleSmartEnter(e);
    }
  };
  ta.addEventListener('keydown', onTaKeydown);

  // Wire toolbar buttons.
  const toolbarBtns = overlay.querySelectorAll('#inline-editor-toolbar button[data-md-action]');
  toolbarBtns.forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      applyMdAction(btn.dataset.mdAction);
    };
  });

  const onSave = () => { cleanup(); callback(ta.value); };
  const onCancel = () => { cleanup(); callback(null); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
  };

  function cleanup() {
    overlay.hidden = true;
    ta.oninput = null;
    ta.removeEventListener('keydown', onTaKeydown);
    toolbarBtns.forEach((btn) => { btn.onclick = null; });
    document.getElementById('inline-editor-save').onclick = null;
    document.getElementById('inline-editor-cancel').onclick = null;
    document.removeEventListener('keydown', onKey);
  }

  document.getElementById('inline-editor-save').onclick = onSave;
  document.getElementById('inline-editor-cancel').onclick = onCancel;
  document.addEventListener('keydown', onKey);

  overlay.hidden = false;
  ta.focus();
}

// === Markdown formatting helpers for the inline editor ===
//
// Each action operates on the textarea's current selection (or cursor
// position). After mutation, the input event is dispatched so the live
// preview updates.

function applyMdAction(action) {
  const ta = document.getElementById('inline-editor-text');
  if (!ta || ta.offsetParent === null) return;  // editor not visible

  // Table action is special: it opens a visual grid editor rather than
  // pasting a raw markdown template.
  if (action === 'table') {
    openTableEditorAtCursor(ta);
    return;
  }

  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  let result;
  switch (action) {
    case 'bold':   result = wrapInline(value, start, end, '**', '**', 'bold text'); break;
    case 'italic': result = wrapInline(value, start, end, '*', '*', 'italic text'); break;
    case 'code':   result = wrapInline(value, start, end, '`', '`', 'code'); break;
    case 'link':   result = wrapInline(value, start, end, '[', '](https://)', 'link text'); break;
    case 'h2':     result = prefixLines(value, start, end, '## ', 'Heading'); break;
    case 'h3':     result = prefixLines(value, start, end, '### ', 'Heading'); break;
    case 'ul':     result = prefixLines(value, start, end, '- ', 'item'); break;
    case 'ol':     result = prefixLinesOrdered(value, start, end); break;
    case 'quote':  result = prefixLines(value, start, end, '> ', 'quoted text'); break;
    default: return;
  }
  if (!result) return;

  ta.value = result.value;
  ta.setSelectionRange(result.cursorStart, result.cursorEnd);
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function wrapInline(value, start, end, before, after, placeholder) {
  const selected = value.slice(start, end);
  const text = selected || placeholder;
  const newValue = value.slice(0, start) + before + text + after + value.slice(end);
  const cursorStart = start + before.length;
  const cursorEnd = cursorStart + text.length;
  return { value: newValue, cursorStart, cursorEnd };
}

function prefixLines(value, start, end, prefix, placeholder) {
  // Expand selection to whole-line boundaries.
  const firstLineStart = value.lastIndexOf('\n', start - 1) + 1;
  const head = value.slice(0, firstLineStart);
  let body = value.slice(firstLineStart, end);
  const tail = value.slice(end);

  if (!body) body = placeholder || '';

  const lines = body.split('\n');
  const prefixed = lines.map((line) => prefix + line).join('\n');

  return {
    value: head + prefixed + tail,
    cursorStart: firstLineStart + prefix.length,
    cursorEnd: firstLineStart + prefixed.length,
  };
}

function prefixLinesOrdered(value, start, end) {
  const firstLineStart = value.lastIndexOf('\n', start - 1) + 1;
  const head = value.slice(0, firstLineStart);
  let body = value.slice(firstLineStart, end) || 'item';
  const tail = value.slice(end);

  const lines = body.split('\n');
  const prefixed = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');

  return {
    value: head + prefixed + tail,
    cursorStart: firstLineStart + 3,  // after "1. "
    cursorEnd: firstLineStart + prefixed.length,
  };
}

// === Visual table editor ===
//
// `openTableEditorAtCursor(ta)` looks at the cursor in the inline editor's
// textarea. If the caret sits inside a markdown table, parse it and open
// the visual editor pre-populated. Otherwise open with an empty 3×3
// template. On Apply, serialize the grid back to markdown pipes and
// replace the original block (or insert at cursor).
//
// Cells are plain <input> elements — they store markdown source as text.
// We deliberately don't try to render inline formatting inside the cell;
// the markdown preserves through editing.

function openTableEditorAtCursor(ta) {
  const value = ta.value;
  const caret = ta.selectionStart;

  const det = detectTableAtCursor(value, caret);

  if (det) {
    openTableEditor(det.rows, (newRows) => {
      const md = serializeTable(newRows);
      ta.value = value.slice(0, det.start) + md + value.slice(det.end);
      ta.setSelectionRange(det.start, det.start + md.length);
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    });
    return;
  }

  // No existing table at cursor — insert a fresh one.
  openTableEditor(
    [
      ['Column 1', 'Column 2', 'Column 3'],
      ['',         '',         ''        ],
      ['',         '',         ''        ],
    ],
    (newRows) => {
      const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
      const needsLead = lineStart > 0
        && value[lineStart - 1] !== '\n'
        && value.slice(lineStart - 2, lineStart) !== '\n\n';
      const md = (needsLead ? '\n' : '') + serializeTable(newRows) + '\n';
      ta.value = value.slice(0, lineStart) + md + value.slice(lineStart);
      const pos = lineStart + md.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    },
  );
}

// Walk the source for all markdown table blocks; return their absolute
// `{ start, end }` offsets in document order. Used to map preview tables
// (the Nth <table> in preview) back to their source position.
function findAllTablesInSource(value) {
  const isTableLine = (s) => /^\s*\|.*\|\s*$/.test(s);
  const tables = [];
  let i = 0;
  while (i < value.length) {
    let nl = value.indexOf('\n', i);
    if (nl === -1) nl = value.length;
    const line = value.slice(i, nl);
    if (isTableLine(line)) {
      const start = i;
      let end = nl;
      let pos = nl < value.length ? nl + 1 : value.length;
      while (pos < value.length) {
        let nl2 = value.indexOf('\n', pos);
        if (nl2 === -1) nl2 = value.length;
        const ln = value.slice(pos, nl2);
        if (!isTableLine(ln)) break;
        end = nl2;
        pos = nl2 < value.length ? nl2 + 1 : value.length;
      }
      tables.push({ start, end });
      i = pos;
    } else {
      i = nl < value.length ? nl + 1 : value.length;
    }
  }
  return tables;
}

// After each preview render, wrap every <table> in a hover container with
// an "Edit table" button. Click → re-locate the corresponding markdown
// table in the source by index, parse it, and open the visual editor.
function attachPreviewTableHandlers(previewEl, ta) {
  const tablesInPreview = previewEl.querySelectorAll('table');
  tablesInPreview.forEach((tableEl, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-table-wrap';
    tableEl.parentNode.insertBefore(wrap, tableEl);
    wrap.appendChild(tableEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preview-table-edit-btn';
    btn.textContent = '✎ Edit table';
    btn.title = 'Edit this table in a visual grid';
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Re-detect at click time — the source may have changed since render.
      const tables = findAllTablesInSource(ta.value);
      const cur = tables[idx];
      if (!cur) return;
      const md = ta.value.slice(cur.start, cur.end);
      const rows = parseTable(md);
      if (!rows.length) return;
      openTableEditor(rows, (newRows) => {
        const newMd = serializeTable(newRows);
        ta.value = ta.value.slice(0, cur.start) + newMd + ta.value.slice(cur.end);
        ta.dispatchEvent(new Event('input'));
      });
    };
    wrap.appendChild(btn);
  });
}

// Identify a markdown table at the caret position. Returns
// `{ start, end, rows }` (start/end are absolute offsets in `value`)
// or `null` if the caret isn't in a table.
function detectTableAtCursor(value, caret) {
  const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);

  // Current line containing the caret.
  let lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = value.indexOf('\n', caret);
  if (lineEnd === -1) lineEnd = value.length;
  const currentLine = value.slice(lineStart, lineEnd);
  if (!isTableLine(currentLine)) return null;

  // Walk up to find the table's first line.
  let start = lineStart;
  while (start > 0) {
    const prevEnd = start - 1;                       // the newline
    const prevStart = value.lastIndexOf('\n', prevEnd - 1) + 1;
    const prevLine = value.slice(prevStart, prevEnd);
    if (!isTableLine(prevLine)) break;
    start = prevStart;
  }

  // Walk down to find the table's last line.
  let end = lineEnd;
  while (end < value.length) {
    const nextStart = end + 1;                       // skip the newline
    let nextEnd = value.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = value.length;
    const nextLine = value.slice(nextStart, nextEnd);
    if (!isTableLine(nextLine)) break;
    end = nextEnd;
  }

  const block = value.slice(start, end);
  const rows = parseTable(block);
  if (!rows.length) return null;
  return { start, end, rows };
}

function parseTable(text) {
  const isSep = (line) => /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|\s*$/.test(line);
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (isSep(line)) continue;
    // Strip leading/trailing | and split.
    const inner = line.replace(/^\|/, '').replace(/\|$/, '');
    const cells = inner.split('|').map((c) => c.trim());
    rows.push(cells);
  }
  // Pad all rows to the widest column count.
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (const r of rows) while (r.length < cols) r.push('');
  return rows;
}

function serializeTable(rows) {
  if (!rows.length) return '';
  // Markdown table cells must be single-line. Collapse any newlines
  // (which the textarea cells may now contain) to a single space.
  const clean = (s) =>
    String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const cols = rows[0].length;
  const lines = [];
  lines.push('| ' + rows[0].map(clean).join(' | ') + ' |');
  lines.push('|' + Array(cols).fill('---').join('|') + '|');
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i].map(clean).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function openTableEditor(initialRows, onApply) {
  // Work on a deep copy so Cancel discards changes cleanly.
  let rows = initialRows.map((r) => [...r]);
  if (!rows.length) rows = [['Header']];

  const overlay = document.getElementById('table-editor');
  const wrap = document.getElementById('table-editor-grid-wrap');

  const render = () => {
    wrap.innerHTML = '';
    const cols = rows[0].length;

    const table = document.createElement('table');
    table.className = 'te-grid';

    // Row 0: per-column delete buttons (skip the corner cell).
    const colCtl = document.createElement('tr');
    colCtl.appendChild(document.createElement('td')).className = 'te-axis';
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td');
      td.className = 'te-axis';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '−';
      btn.title = 'Delete this column';
      btn.onclick = () => {
        if (rows[0].length <= 1) return;
        rows.forEach((r) => r.splice(c, 1));
        render();
      };
      td.appendChild(btn);
      colCtl.appendChild(td);
    }
    table.appendChild(colCtl);

    // Row 1+: header + data rows.
    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement('tr');
      if (r === 0) tr.className = 'te-header';

      // First cell: row delete button (skip for header).
      const axis = document.createElement('td');
      axis.className = 'te-axis';
      if (r > 0) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '−';
        btn.title = 'Delete this row';
        btn.onclick = () => {
          if (rows.length <= 1) return;
          rows.splice(r, 1);
          render();
        };
        axis.appendChild(btn);
      }
      tr.appendChild(axis);

      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        // Cells are <textarea> rather than <input> so that long markdown
        // text wraps and grows vertically rather than getting truncated
        // off the right edge of a one-line input.
        const inp = document.createElement('textarea');
        inp.value = rows[r][c] || '';
        inp.rows = 1;
        inp.dataset.row = r;
        inp.dataset.col = c;
        inp.oninput = () => {
          rows[r][c] = inp.value;
          autoGrowCell(inp);
        };
        inp.addEventListener('keydown', (e) => onCellKey(e, r, c));
        td.appendChild(inp);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    wrap.appendChild(table);
  };

  const focusCell = (r, c) => {
    const cols = rows[0].length;
    if (c < 0) { c = cols - 1; r--; }
    if (c >= cols) { c = 0; r++; }
    if (r < 0 || r >= rows.length) return false;
    const sel = wrap.querySelector(`textarea[data-row="${r}"][data-col="${c}"]`);
    if (sel) { sel.focus(); sel.select(); return true; }
    return false;
  };

  const onCellKey = (e, r, c) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      focusCell(r, c + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'ArrowUp' && e.target.selectionStart === 0) {
      e.preventDefault();
      focusCell(r - 1, c);
    } else if (e.key === 'ArrowDown' && e.target.selectionStart === e.target.value.length) {
      e.preventDefault();
      focusCell(r + 1, c);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doApply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      doCancel();
    }
  };

  // Footer controls.
  overlay.querySelectorAll('button[data-te-action]').forEach((btn) => {
    btn.onclick = () => {
      const cols = rows[0].length;
      if (btn.dataset.teAction === 'add-row') {
        rows.push(new Array(cols).fill(''));
      } else if (btn.dataset.teAction === 'add-col') {
        rows.forEach((r) => r.push(''));
      }
      render();
    };
  });

  const doApply = () => { cleanup(); onApply(rows); };
  const doCancel = () => { cleanup(); };
  // stopImmediatePropagation so the underlying inline-editor's own
  // Esc / ⌘+Enter handlers don't also fire (they live on document too).
  const onGlobalKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      doCancel();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      doApply();
    }
  };

  function cleanup() {
    overlay.hidden = true;
    overlay.querySelectorAll('button[data-te-action]').forEach((b) => { b.onclick = null; });
    document.getElementById('table-editor-apply').onclick = null;
    document.getElementById('table-editor-cancel').onclick = null;
    document.removeEventListener('keydown', onGlobalKey);
  }

  document.getElementById('table-editor-apply').onclick = doApply;
  document.getElementById('table-editor-cancel').onclick = doCancel;
  document.addEventListener('keydown', onGlobalKey);

  render();
  overlay.hidden = false;
  // Auto-size every textarea once they're in the DOM (CSS field-sizing
  // covers most browsers; this is a belt-and-suspenders fallback).
  wrap.querySelectorAll('textarea').forEach(autoGrowCell);
  // Focus the first cell.
  const first = wrap.querySelector('textarea');
  if (first) { first.focus(); first.select(); }
}

// JS fallback for `field-sizing: content` — resize a textarea to fit
// its content by toggling height to auto and reading scrollHeight.
function autoGrowCell(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
}

// Smart Enter inside the textarea: if the current line starts with a list
// or blockquote marker, the next line gets the same marker auto-inserted.
// Pressing Enter on an empty marker line exits the list instead.
function handleSmartEnter(e) {
  const ta = e.target;
  const value = ta.value;
  const start = ta.selectionStart;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const line = value.slice(lineStart, start);

  // Bullet list: -, *, or +
  let m = line.match(/^(\s*)([-*+])\s+(.*)$/);
  if (m) {
    const [, indent, bullet, content] = m;
    return continueOrExit(ta, e, start, lineStart, content, indent + bullet + ' ');
  }

  // Numbered list
  m = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (m) {
    const [, indent, num, content] = m;
    const nextPrefix = indent + (parseInt(num) + 1) + '. ';
    return continueOrExit(ta, e, start, lineStart, content, nextPrefix);
  }

  // Blockquote
  m = line.match(/^(\s*>\s+)(.*)$/);
  if (m) {
    const [, prefix, content] = m;
    return continueOrExit(ta, e, start, lineStart, content, prefix);
  }
}

function continueOrExit(ta, e, caret, lineStart, contentOnLine, nextPrefix) {
  const value = ta.value;
  if (contentOnLine.trim() === '') {
    // Empty list/quote line — exit the structure by removing the prefix.
    e.preventDefault();
    ta.value = value.slice(0, lineStart) + value.slice(caret);
    ta.setSelectionRange(lineStart, lineStart);
    ta.dispatchEvent(new Event('input'));
  } else {
    // Continue the list/quote on the next line.
    e.preventDefault();
    const insertion = '\n' + nextPrefix;
    ta.value = value.slice(0, caret) + insertion + value.slice(caret);
    ta.setSelectionRange(caret + insertion.length, caret + insertion.length);
    ta.dispatchEvent(new Event('input'));
  }
}

// ============================== Diff tab =============================
//
// Word-level inline diff between the previous-round snapshot and the
// current file content (markdown source, not rendered HTML — we want the
// user to see the actual textual changes the agent made, including
// markdown structure changes like added headings).

function renderDiffTab() {
  const container = document.getElementById('diff-view');
  container.innerHTML = '';
  // Comments are hidden on this tab — clear the count too so a stale
  // number from another tab doesn't sit in the header.
  document.getElementById('comments-count').textContent = '';

  if (!currentFile) return;
  const baseline = baselines[currentFile.name];
  if (!baseline) {
    container.textContent = 'No previous round to diff against.';
    return;
  }

  // (A) Self-review panel — agent's per-subsection narration of what it
  // did in the current round. Sits at the top of the Diff tab so the
  // user can read "why" before scanning the textual "what". Drawn even
  // when the prose diff is empty (the agent may have only updated its
  // notes; that's still review-worthy).
  const reviews = extractSelfReviewBlocks(currentFile.content);
  if (reviews.length) {
    container.appendChild(buildSelfReviewPanel(reviews));
  }

  // (B) Textual diff. When the user has metadata hidden, strip it from
  // both sides so the diff stays focused on prose changes (the agent's
  // self-review and changelog comments shouldn't read as edits to the
  // manuscript itself — they're shown above instead).
  const oldText = showMetadata ? baseline.content : stripMetadata(baseline.content);
  const newText = showMetadata ? currentFile.content : stripMetadata(currentFile.content);

  if (oldText === newText) {
    const msg = showMetadata
      ? 'No changes between the previous round and the current file.'
      : 'No prose changes between the previous round and the current file. (Toggle <em>Show metadata</em> to include changelog comments and front-matter.)';
    const p = document.createElement('p');
    p.className = 'diff-empty';
    p.innerHTML = msg;
    container.appendChild(p);
    return;
  }

  if (typeof Diff === 'undefined' || !Diff.diffWordsWithSpace) {
    container.appendChild(document.createTextNode('Diff library failed to load. Reload the page.'));
    return;
  }

  const chunks = Diff.diffWordsWithSpace(oldText, newText);
  const pre = document.createElement('pre');
  pre.className = 'diff-text';
  for (const chunk of chunks) {
    if (chunk.added) {
      const ins = document.createElement('ins');
      ins.className = 'diff-add';
      ins.textContent = chunk.value;
      pre.appendChild(ins);
    } else if (chunk.removed) {
      const del = document.createElement('del');
      del.className = 'diff-del';
      del.textContent = chunk.value;
      pre.appendChild(del);
    } else {
      pre.appendChild(document.createTextNode(chunk.value));
    }
  }
  container.appendChild(pre);
}

// Walk markdown source, find each ### subsection and (if present) the
// `**Self-review notes` block that belongs to it. Returns one entry per
// block in document order: { index (1-based), title, notes (markdown
// source of the bullet list) }.
function extractSelfReviewBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let currentTitle = null;
  let subsectionIndex = 0;
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (/^###\s+/.test(trimmed)) {
      currentTitle = trimmed.replace(/^###\s+/, '');
      subsectionIndex++;
      i++;
      continue;
    }

    if (trimmed.startsWith('**Self-review notes')) {
      // skip the header paragraph
      while (i < lines.length && lines[i].trim() !== '') i++;
      while (i < lines.length && lines[i].trim() === '') i++;
      // collect the bullet block (same rules as the strip path)
      const bullets = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && /^[-*+]\s/.test(lines[j].trim())) {
            bullets.push('');
            i = j;
            continue;
          }
          break;
        }
        if (/^[-*+]\s/.test(t)) { bullets.push(lines[i]); i++; continue; }
        if (/^\s+\S/.test(lines[i])) { bullets.push(lines[i]); i++; continue; }
        break;
      }
      blocks.push({
        index: subsectionIndex || blocks.length + 1,
        title: currentTitle || '(file-level)',
        notes: bullets.join('\n'),
      });
      continue;
    }

    i++;
  }
  return blocks;
}

function buildSelfReviewPanel(reviews) {
  const panel = document.createElement('section');
  panel.className = 'self-review-panel';

  const head = document.createElement('div');
  head.className = 'self-review-panel-head';
  head.innerHTML =
    `<span class="srp-title">Agent self-review</span>` +
    `<span class="srp-count">${reviews.length} subsection${reviews.length === 1 ? '' : 's'}</span>` +
    `<button type="button" class="srp-toggle-all" data-state="closed">Expand all</button>`;
  panel.appendChild(head);

  for (const block of reviews) {
    const details = document.createElement('details');
    details.className = 'self-review-row';
    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="sr-num">§1.${block.index}</span>` +
      `<span class="sr-title">${escapeHtml(block.title)}</span>` +
      `<span class="sr-chev" aria-hidden="true">▾</span>`;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'self-review-body';
    body.innerHTML = renderMarkdownWithMath(block.notes);
    // Self-review bullets are heavy with fl-NNN refs — wrap them too so
    // hover/click works the same as in the main reading view.
    wrapRuleReferences(body);
    details.appendChild(body);

    panel.appendChild(details);
  }

  // Wire "Expand all / Collapse all" toggle for fast scanning.
  const toggleBtn = head.querySelector('.srp-toggle-all');
  toggleBtn.onclick = () => {
    const opening = toggleBtn.dataset.state === 'closed';
    panel.querySelectorAll('details.self-review-row').forEach((d) => {
      d.open = opening;
    });
    toggleBtn.dataset.state = opening ? 'open' : 'closed';
    toggleBtn.textContent = opening ? 'Collapse all' : 'Expand all';
  };

  return panel;
}

// ============================== Reload current file ==================
//
// Re-reads the current file from disk and re-renders the active tab.
// Use case: the user has handed comments to the agent and wants to check
// "is the agent done editing yet?" without refreshing the whole browser
// tab (which would lose the active file selection and tab state).

async function reloadCurrentFile() {
  if (!currentFile || !directoryHandle) return;
  const fname = currentFile.name;
  let text, handle;
  try {
    handle = await resolveFileHandle(fname);
    const file = await handle.getFile();
    text = await file.text();
  } catch (e) {
    console.warn('[redpen] reload failed', e);
    alert('Reload failed: ' + e.message);
    return;
  }

  const changed = text !== currentFile.content;
  const pending = (annotations[fname] || []).length;

  // Danger zone: file moved on disk AND the user has comments anchored
  // against the in-memory version. Silently overwriting would lose the
  // baseline. Route through the safety modal so the user decides
  // (Promote / discard / cancel) instead of paying for a forgotten Proceed.
  if (changed && pending > 0) {
    showReloadSafetyModal({ fname, newText: text, newHandle: handle, pending });
    return;
  }

  // Safe path — no comments to lose, or no change to apply.
  currentFile = { name: fname, handle, content: text };
  renderActiveTab();
  flashReloadButton(changed ? 'Reloaded ✓' : 'No changes');
}

// State for the open reload-safety modal. The fetched content is held here
// so the three choice handlers don't have to re-fetch (avoids racing the
// disk if the agent is still writing).
let pendingReload = null;

function showReloadSafetyModal({ fname, newText, newHandle, pending }) {
  pendingReload = { fname, newText, newHandle };
  document.getElementById('reload-safety-summary').textContent =
    `"${fname}" has been edited since you opened it`;
  document.getElementById('reload-safety-count').textContent =
    `${pending} comment${pending === 1 ? '' : 's'}`;
  // Plan files don't participate in rounds, so "Lock as Prev" is meaningless.
  // Hide the Promote choice; the user picks Discard or Cancel.
  document.getElementById('reload-promote').hidden = isPlanFile(fname);
  document.getElementById('reload-safety-modal').hidden = false;
}

function hideReloadSafetyModal() {
  pendingReload = null;
  document.getElementById('reload-safety-modal').hidden = true;
}

// "Lock this round, then load." Synthetic Proceed: snapshot the in-memory
// (pre-disk-edit) state into baseline, clear current comments, then swap
// in the freshly-read disk content. No second confirm dialog — the
// safety modal already collected user intent.
function reloadByPromoting() {
  if (!pendingReload || !currentFile) return;
  const { fname, newText, newHandle } = pendingReload;
  const cur = annotations[fname] || [];

  baselines[fname] = {
    content: currentFile.content,
    annotations: cur.slice(),
    timestamp: Date.now(),
  };
  delete annotations[fname];
  persistBaselines();
  persistAnnotations();

  currentFile = { name: fname, handle: newHandle, content: newText };
  hideReloadSafetyModal();
  refreshTabAvailability();
  renderActiveTab();
  flashReloadButton('Locked + loaded ✓');
}

function reloadByDiscarding() {
  if (!pendingReload || !currentFile) return;
  const { fname, newText, newHandle } = pendingReload;
  delete annotations[fname];
  persistAnnotations();
  currentFile = { name: fname, handle: newHandle, content: newText };
  hideReloadSafetyModal();
  refreshTabAvailability();
  renderActiveTab();
  flashReloadButton('Reloaded (comments discarded)');
}

function flashReloadButton(label) {
  const btn = document.getElementById('reload-current-file');
  if (!btn) return;
  const orig = btn.dataset.origLabel || btn.innerHTML;
  btn.dataset.origLabel = orig;
  btn.textContent = label;
  setTimeout(() => { btn.innerHTML = btn.dataset.origLabel; }, 1200);
}

// ============================== Promote to next round =================
//
// Snapshots a file's content + this round's comments into the previous-
// round slot, then clears that round's comments. The user marks "I'm
// done with this review pass; lock it in as what I sent to the agent".
// Next time they open the file (after the agent has edited it on disk),
// the Diff tab will show what changed.
//
// Two entry points:
//   - promoteToNextRound(): the explicit Proceed button. Confirms first
//     because it's a destructive action with no surrounding context.
//   - silentPromoteScope(): bundled into Copy / Save in the export modal.
//     No confirm — the act of sending comments to the agent IS the
//     consent. The modal shows a hint up front so the user knows.

// Read the file's content for the baseline snapshot. Uses in-memory
// currentFile.content when possible (avoids a disk roundtrip and
// preserves whatever the user actually saw and annotated against);
// otherwise reads from disk.
async function snapshotContentFor(fname) {
  if (currentFile && currentFile.name === fname) return currentFile.content;
  try {
    const handle = await resolveFileHandle(fname);
    const file = await handle.getFile();
    return await file.text();
  } catch (e) {
    console.warn('[redpen] snapshot read failed', fname, e);
    return null;
  }
}

// One file's snapshot work, with no policy checks beyond "is it a plan?"
// and "can we read its content?". Caller decides whether the file is
// worth promoting at all (e.g., bundled-export skips zero-comment files
// while the explicit Proceed button allows them).
async function snapshotOneFileToBaseline(fname) {
  if (!fname || isPlanFile(fname)) return false;
  const content = await snapshotContentFor(fname);
  if (content === null) return false;
  const cur = annotations[fname] || [];
  baselines[fname] = {
    content,
    annotations: cur.slice(),
    timestamp: Date.now(),
  };
  delete annotations[fname];
  return true;
}

// Shared persist + re-read + UI refresh, after one or more files have
// been snapshotted into the baseline slot.
async function finalizePromote(promotedFiles) {
  if (promotedFiles.length === 0) return;
  persistAnnotations();
  persistBaselines();
  if (currentFile && promotedFiles.includes(currentFile.name)) {
    try {
      const handle = await resolveFileHandle(currentFile.name);
      const file = await handle.getFile();
      currentFile = { name: currentFile.name, handle, content: await file.text() };
    } catch (e) {
      console.warn('[redpen] re-read after promote failed', e);
    }
  }
  refreshTabAvailability();
  renderActiveTab();
}

// Bundled into Copy / Save in the export modal. Promotes every file in
// scope that actually has comments. No confirm — the act of sending the
// comments IS the consent; the modal shows a hint up front so the user
// knows.
async function silentPromoteScope(scope) {
  const candidates = scope === 'current'
    ? (currentFile ? [currentFile.name] : [])
    : Object.keys(annotations);

  const promoted = [];
  for (const fname of candidates) {
    if (isPlanFile(fname)) continue;
    const cur = annotations[fname] || [];
    if (cur.length === 0) continue;
    if (await snapshotOneFileToBaseline(fname)) promoted.push(fname);
  }
  await finalizePromote(promoted);
  return promoted;
}

// Explicit Proceed button. Current file only, confirms first because the
// action runs outside any surrounding export context.
async function promoteToNextRound() {
  if (!currentFile || !isInteractiveTab()) return;
  if (isPlanFile(currentFile.name)) return;  // plans don't have rounds
  const fname = currentFile.name;
  const cur = annotations[fname] || [];
  const prev = baselines[fname];

  let msg;
  if (prev) {
    msg =
      `Lock the current version of "${fname}" as the new previous-round baseline?\n\n` +
      `What this does:\n` +
      `  • Discards the existing previous round (${prev.annotations.length} comment(s)).\n` +
      `  • Snapshots the file you just reviewed + your ${cur.length} comment(s) as the new baseline.\n` +
      `  • Re-reads "${fname}" from disk so the Current tab reflects whatever's there now.\n` +
      `  • Clears your current comments so the next round starts blank.\n\n` +
      `This cannot be undone.`;
  } else {
    msg =
      `Lock the current version of "${fname}" as the previous-round baseline?\n\n` +
      `What this does:\n` +
      `  • Snapshots the file you just reviewed + your ${cur.length} comment(s).\n` +
      `  • Re-reads "${fname}" from disk so the Current tab reflects whatever's there now.\n` +
      `  • Clears your current comments so the next round starts blank.\n\n` +
      `Continue?`;
  }
  if (!confirm(msg)) return;

  if (await snapshotOneFileToBaseline(fname)) {
    await finalizePromote([fname]);
  }
}

// ============================== UI event bindings ====================

function bindUIEvents() {
  document.getElementById('open-folder').onclick = openFolder;
  document.getElementById('export-comments').onclick = showExportModal;
  document.getElementById('open-rules-editor').onclick = openRulesEditor;
  document.getElementById('add-general-note').onclick = addGeneralNote;
  document.getElementById('proceed-next-round').onclick = promoteToNextRound;
  document.getElementById('reload-current-file').onclick = reloadCurrentFile;
  document.getElementById('toggle-metadata').onclick = toggleShowMetadata;
  document.getElementById('jump-back').onclick = jumpBack;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => setActiveTab(btn.dataset.tab);
  });

  document.getElementById('close-export').onclick = () => {
    document.getElementById('export-modal').hidden = true;
  };
  document.getElementById('copy-clipboard').onclick = copyToClipboard;
  document.getElementById('save-file').onclick = saveAsFile;

  document.getElementById('clear-comments').onclick = showClearCommentsModal;
  document.getElementById('close-clear').onclick = hideClearCommentsModal;
  document.getElementById('clear-cancel').onclick = hideClearCommentsModal;
  document.getElementById('clear-confirm').onclick = confirmClearComments;

  document.getElementById('close-reload-safety').onclick = hideReloadSafetyModal;
  document.getElementById('reload-cancel').onclick = hideReloadSafetyModal;
  document.getElementById('reload-promote').onclick = reloadByPromoting;
  document.getElementById('reload-discard').onclick = reloadByDiscarding;

  document.getElementById('close-rules').onclick = hideRulesEditor;

  document.getElementById('comment-save').onclick = saveComment;
  document.getElementById('comment-cancel').onclick = () => {
    hideCommentPopup();
  };

  // First time the user actually engages with the popup, swap the
  // deferred native selection for the persistent .pending-annotation
  // mark. Focusin fires when the user clicks into the textarea, tabs
  // in, or clicks any button — all of which would collapse the native
  // selection anyway, so this is the right moment to commit.
  document.getElementById('comment-popup').addEventListener('focusin', () => {
    commitPendingHighlight();
  });

  // Click outside the popup dismisses it without saving — the user
  // probably just wants the popup gone (e.g. to read the article, or
  // because the auto-popup was unwanted in the first place). Don't
  // touch the user's selection; let the browser handle it normally.
  document.addEventListener('mousedown', (e) => {
    const popup = document.getElementById('comment-popup');
    if (popup.hidden) return;
    if (popup.contains(e.target)) return;
    // Margin §-anchor clicks open their own paragraph-note popup via
    // addParagraphNote, which calls hideCommentPopup at the top to clean
    // up the previous popup. Let that flow run.
    if (e.target.closest && e.target.closest('.anchor-label')) return;
    hideCommentPopup();
  });

  // Comment textarea: ⌘+Enter to save, Esc to cancel.
  document.getElementById('comment-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveComment();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideCommentPopup();
    }
  });

  // Single delegated click handler on the article: dispatches between
  // (a) clicks on the margin §-anchor label → start a paragraph-level
  // note for that paragraph, and (b) clicks on existing mark highlights
  // → scroll the right pane to that card and flash it.
  document.getElementById('rendered').addEventListener('click', (e) => {
    const label = e.target.closest('.anchor-label');
    if (label) {
      e.preventDefault();
      e.stopPropagation();
      addParagraphNote(label.dataset.anchor);
      return;
    }
    const mark = e.target.closest('mark.annotation');
    if (mark) {
      e.preventDefault();
      const annId = mark.dataset.annId;
      const card = document.querySelector(`.comment-card[data-ann-id="${annId}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1200);
    }
  });

  // Global Esc closes any open modal/popup.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('comment-popup').hidden) hideCommentPopup();
    else if (!document.getElementById('reload-safety-modal').hidden) hideReloadSafetyModal();
    else if (!document.getElementById('clear-comments-modal').hidden) hideClearCommentsModal();
    else if (!document.getElementById('export-modal').hidden) {
      document.getElementById('export-modal').hidden = true;
    } else if (!document.getElementById('rules-modal').hidden) {
      hideRulesEditor();
    }
  });

  // ⌘+E to open export modal (when a file is open).
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'e' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      if (!document.getElementById('export-comments').disabled) {
        e.preventDefault();
        showExportModal();
      }
    }
  });

  bindSelectionHandlers();
}

// ============================== Boot ================================

document.addEventListener('DOMContentLoaded', init);
