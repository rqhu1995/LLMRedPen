/* md-annotator — main browser logic.
 *
 * Single-folder workflow:
 *   1. User picks a paper folder via showDirectoryPicker() — must contain CLAUDE.md at root.
 *   2. Sidebar lists all .md files in that folder.
 *   3. Clicking a file renders it (markdown-it + KaTeX) with §-section and ¶-paragraph markers.
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
let annotations = {};         // { filename: [ { anchor, text, comment, ... } ] }
let mdParser = null;          // markdown-it instance
let activeSelection = null;   // { text, anchor, contextBefore, contextAfter, charOffset }
let rulesData = null;         // { handle, text, sections } while rules editor is open

// Set of annotation timestamps that couldn't be located in the current
// rendered file. Rebuilt every applyExistingHighlights() pass.
const orphans = new Set();

// When non-null, the next text selection inside the article is treated as
// a re-anchor target for the annotation with this timestamp, instead of
// creating a new annotation.
let pendingReanchorId = null;

// localStorage / IndexedDB keys kept as `mda:` and `mda` respectively
// (legacy from when the project was named md-annotator) so that existing
// users keep their saved annotations and folder handle after the rename
// to LLMRedPen. Do not change without a migration step.
const ANNOTATIONS_PREFIX = 'mda:';
const CONTEXT_LEN = 32;  // chars of prefix/suffix stored on new annotations

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
  bindUIEvents();
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
  // Refuse folders that don't have CLAUDE.md at their root.
  try {
    await handle.getFileHandle('CLAUDE.md');
  } catch (e) {
    alert(`"${handle.name}" does not contain CLAUDE.md at its root.\n\nThis viewer expects a paper folder where CLAUDE.md (the writing-rules file) lives next to the manuscript .md files. Try a different folder.`);
    return;
  }

  directoryHandle = handle;
  await saveHandle(handle);

  const nameEl = document.getElementById('folder-name');
  nameEl.textContent = handle.name;
  nameEl.title = handle.name;

  await listFiles();
  loadAnnotations();

  document.getElementById('export-comments').disabled = false;
  document.getElementById('open-rules-editor').disabled = false;
  document.getElementById('comments-pane').hidden = false;

  renderCommentsList();
}

async function listFiles() {
  const files = [];
  for await (const [name, entry] of directoryHandle.entries()) {
    if (entry.kind === 'file' && name.endsWith('.md')) {
      files.push(name);
    }
  }
  files.sort((a, b) => a.localeCompare(b));

  const list = document.getElementById('file-list');
  list.innerHTML = '';
  for (const name of files) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'file-link';
    a.textContent = name;
    a.dataset.filename = name;
    a.onclick = (e) => { e.preventDefault(); openFile(name); };
    list.appendChild(a);
  }
}

// ============================== File rendering =======================

async function openFile(name) {
  const handle = await directoryHandle.getFileHandle(name);
  const file = await handle.getFile();
  const text = await file.text();
  currentFile = { name, handle, content: text };

  document.querySelectorAll('.file-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.filename === name);
  });

  // A file is now open — general notes can be added against it.
  document.getElementById('add-general-note').disabled = false;

  document.getElementById('welcome').hidden = true;
  const rendered = document.getElementById('rendered');
  rendered.hidden = false;
  rendered.innerHTML = renderMarkdownWithMath(text);

  numberSectionsAndParagraphs(rendered);
  refreshAnnotationsUI();

  // Scroll to top of newly opened file.
  document.getElementById('content').scrollTop = 0;
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

  // Re-anchor branch: if the user just clicked "Re-anchor" on an orphan
  // card, treat this selection as the new home for that comment rather
  // than opening a popup for a new annotation.
  if (pendingReanchorId !== null) {
    const trimmed = text.trim();
    const newData = {
      anchor: anchorEl.dataset.anchor,
      text: trimmed,
      contextBefore: textBefore(range, anchorEl, CONTEXT_LEN),
      contextAfter: textAfter(range, anchorEl, CONTEXT_LEN),
      charOffset: computeArticleCharOffset(range),
    };
    const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
    const ok = confirm(`Re-anchor this comment to:\n\n  ${newData.anchor}\n  "${preview}"\n\nProceed?`);
    if (ok) reanchorAnnotation(pendingReanchorId, newData);
    cancelReanchor();
    window.getSelection().removeAllRanges();
    return;
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

// Show the comment popup. Two independent parameters:
//   positionRect — DOMRect-like ({top, bottom, left, right}) for where to
//                  anchor the popup on screen. null = center on viewport.
//   pendingRange — Range to wrap in a transient <mark.pending-annotation>
//                  for visual selection feedback. null = no pending mark
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

  // Apply pending highlight only when a real Range was provided. Paragraph-
  // level notes use the `.pending-paragraph` block outline instead (set
  // by the caller).
  if (pendingRange) applyPendingHighlight(pendingRange);

  const label =
    activeSelection.type === 'general' ? '— note (not anchored)' :
    !activeSelection.text             ? activeSelection.anchor + ' — whole paragraph' :
                                        activeSelection.anchor;
  document.getElementById('comment-anchor-display').textContent = label;

  popup.hidden = false;

  const ta = document.getElementById('comment-text');
  ta.value = '';
  ta.focus();
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
  // Don't clear selection — user might still want to re-select.
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

  // Reset orphan set; will be rebuilt as each annotation locates (or fails).
  orphans.clear();

  // Only anchored comments get article highlights; general notes have no text.
  // The 4-layer locator (see highlightOne / locateAnnotation) needs the
  // current article text map fresh each call because successful highlights
  // mutate the DOM by wrapping text in <mark> elements.
  const anns = annotations[currentFile.name] || [];
  for (const ann of anns) {
    if (ann.type === 'general') continue;
    highlightOne(ann);
  }
}

// 4-layer annotation locator + highlighter. Modelled on the Hypothesis
// client (https://github.com/hypothesis/client) anchoring pipeline.
//
//   Layer 1: structural anchor (§S ¶N) + exact text inside that block
//   Layer 2: stored char offset ± slack + exact text
//   Layer 3: full-article search for `prefix + text + suffix` (exact)
//   Layer 4: full-article search for `prefix + ANYTHING + suffix`
//            — both prefix and suffix must be present; the middle becomes
//              the re-anchored text portion (handles in-place paraphrase)
//
// On failure the annotation is flagged orphaned (`orphans.add(timestamp)`)
// and shows up in the right pane with re-anchor / to-note / delete buttons.
// We do NOT write the resolved location back to localStorage — every pass
// re-anchors from the original selectors, so small per-session drift does
// not accumulate across many file revisions (same choice as Hypothesis).
function highlightOne(ann) {
  if (!ann.text) return;

  const article = document.getElementById('rendered');
  const map = buildTextMap(article);

  const loc = locateAnnotation(ann, map, article);
  if (!loc) {
    orphans.add(ann.timestamp);
    return;
  }

  const range = offsetsToRange(map, loc.start, loc.end);
  if (!range) {
    orphans.add(ann.timestamp);
    return;
  }

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
    console.warn('[mda] highlightOne wrap failed', err);
    orphans.add(ann.timestamp);
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

function buildExportText() {
  const files = Object.keys(annotations).filter((f) => (annotations[f] || []).length).sort();
  if (!files.length) return '(no annotations yet)';

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

function compareByAnchor(a, b) {
  // Sort order: orphans first (so the user sees them and can act), then
  // general notes, then anchored comments by §S ¶N, then creation time.
  const aOrph = orphans.has(a.timestamp);
  const bOrph = orphans.has(b.timestamp);
  if (aOrph !== bOrph) return aOrph ? -1 : 1;

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
  renderExportList();
  document.getElementById('export-modal').hidden = false;
}

function renderExportList() {
  document.getElementById('export-text').textContent = buildExportText();
}

async function copyToClipboard() {
  const text = buildExportText();
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('copy-clipboard');
    const orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
}

async function saveAsFile() {
  if (!directoryHandle) return;
  const text = buildExportText();
  const suggested = `${directoryHandle.name}-comments.txt`;

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      startIn: directoryHandle,
      types: [{
        description: 'Plain text',
        accept: { 'text/plain': ['.txt', '.md'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();

    const btn = document.getElementById('save-file');
    const orig = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    if (e.name !== 'AbortError') alert('Save failed: ' + e.message);
  }
}

function clearAllAnnotations() {
  if (!confirm('Delete all annotations across all files in this folder?\n\nThis cannot be undone.')) return;
  annotations = {};
  persistAnnotations();
  refreshAnnotationsUI();
  renderExportList();
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

  const anns = (annotations[currentFile.name] || []).slice().sort(compareByAnchor);
  count.textContent = anns.length ? `${anns.length}` : '';

  if (!anns.length) {
    list.innerHTML = '<p class="empty">No comments on this file yet.<br>Select text in the article to add one.</p>';
    return;
  }

  list.innerHTML = '';
  for (const ann of anns) {
    list.appendChild(buildCommentCard(ann));
  }
}

function buildCommentCard(ann) {
  const isGeneral = ann.type === 'general';
  const isOrphan = orphans.has(ann.timestamp);

  const card = document.createElement('div');
  card.className = 'comment-card'
    + (isGeneral ? ' general' : '')
    + (isOrphan ? ' orphan' : '');
  card.dataset.annId = String(ann.timestamp);

  const header = document.createElement('div');
  header.className = 'comment-card-header';

  const anchor = document.createElement('span');
  anchor.className = 'comment-anchor';
  anchor.textContent = isGeneral ? 'note' : ann.anchor;
  if (isOrphan) {
    anchor.appendChild(document.createTextNode(' '));
    const badge = document.createElement('span');
    badge.className = 'orphan-badge';
    badge.textContent = '⚠ orphan';
    anchor.appendChild(badge);
  }
  header.appendChild(anchor);

  const actions = document.createElement('div');
  actions.className = 'comment-actions';

  const editBtn = document.createElement('button');
  editBtn.textContent = 'Edit';
  editBtn.onclick = (e) => { e.stopPropagation(); editComment(ann.timestamp); };
  actions.appendChild(editBtn);

  if (isOrphan) {
    const reBtn = document.createElement('button');
    reBtn.textContent = 'Re-anchor';
    reBtn.onclick = (e) => { e.stopPropagation(); startReanchor(ann.timestamp); };
    actions.appendChild(reBtn);

    const noteBtn = document.createElement('button');
    noteBtn.textContent = 'To note';
    noteBtn.title = 'Convert to a general note (drops the lost anchor)';
    noteBtn.onclick = (e) => { e.stopPropagation(); convertToNote(ann.timestamp); };
    actions.appendChild(noteBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.className = 'danger';
  delBtn.onclick = (e) => { e.stopPropagation(); deleteComment(ann.timestamp); };
  actions.appendChild(delBtn);

  header.appendChild(actions);
  card.appendChild(header);

  if (isOrphan) {
    const meta = document.createElement('div');
    meta.className = 'orphan-meta';
    meta.textContent = `was at ${ann.anchor} — original text not locatable in current file`;
    card.appendChild(meta);
  }

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

  // Navigation only makes sense for anchored comments that ARE anchored.
  if (!isGeneral && !isOrphan) {
    card.addEventListener('click', () => scrollToAnchor(ann));
    bindCardHover(card, ann);
  }

  return card;
}

// === Re-anchor + convert-to-note ===
//
// Both operations apply to a single orphan card. Re-anchor enters a mode
// where the next text selection in the article becomes the new home
// (instead of starting a new annotation). Convert-to-note drops the
// anchor/text/context entirely and keeps just the comment body as a
// general note.

function startReanchor(timestamp) {
  pendingReanchorId = timestamp;
  document.body.classList.add('reanchor-mode');
  // If something was selected when the user clicked Re-anchor, clear it so
  // the new mouseup actually fires on a fresh selection.
  window.getSelection().removeAllRanges();
}

function cancelReanchor() {
  pendingReanchorId = null;
  document.body.classList.remove('reanchor-mode');
}

function reanchorAnnotation(timestamp, newData) {
  if (!currentFile) return;
  const fname = currentFile.name;
  const ann = (annotations[fname] || []).find((a) => a.timestamp === timestamp);
  if (!ann) return;
  ann.type = 'anchored';
  ann.anchor = newData.anchor;
  ann.text = newData.text;
  ann.contextBefore = newData.contextBefore;
  ann.contextAfter = newData.contextAfter;
  ann.charOffset = newData.charOffset;
  persistAnnotations();
  refreshAnnotationsUI();
}

function convertToNote(timestamp) {
  if (!currentFile) return;
  const fname = currentFile.name;
  const ann = (annotations[fname] || []).find((a) => a.timestamp === timestamp);
  if (!ann) return;
  if (!confirm('Convert this orphaned comment into a general note?\n\nThe anchor and quoted text are dropped; only your comment body is kept.')) return;
  ann.type = 'general';
  ann.anchor = '_general';
  ann.text = '';
  ann.contextBefore = '';
  ann.contextAfter = '';
  delete ann.charOffset;
  orphans.delete(timestamp);
  persistAnnotations();
  refreshAnnotationsUI();
}

function scrollToAnchor(ann) {
  const rendered = document.getElementById('rendered');
  const block = Array.from(rendered.querySelectorAll('[data-anchor]'))
    .find((el) => el.dataset.anchor === ann.anchor);
  if (!block) return;
  block.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Flash the matching mark for text-selection annotations, or the whole
  // paragraph for paragraph-level (no-text) annotations.
  const mark = block.querySelector(`mark.annotation[data-ann-id="${ann.timestamp}"]`);
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
  const handle = await directoryHandle.getFileHandle('CLAUDE.md');
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

// ============================== UI event bindings ====================

function bindUIEvents() {
  document.getElementById('open-folder').onclick = openFolder;
  document.getElementById('export-comments').onclick = showExportModal;
  document.getElementById('open-rules-editor').onclick = openRulesEditor;
  document.getElementById('add-general-note').onclick = addGeneralNote;

  document.getElementById('close-export').onclick = () => {
    document.getElementById('export-modal').hidden = true;
  };
  document.getElementById('copy-clipboard').onclick = copyToClipboard;
  document.getElementById('save-file').onclick = saveAsFile;
  document.getElementById('clear-all').onclick = clearAllAnnotations;

  document.getElementById('close-rules').onclick = hideRulesEditor;

  document.getElementById('comment-save').onclick = saveComment;
  document.getElementById('comment-cancel').onclick = () => {
    hideCommentPopup();
  };

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

  // Global Esc closes any open modal/popup, or cancels reanchor mode.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pendingReanchorId !== null) { cancelReanchor(); return; }
    if (!document.getElementById('comment-popup').hidden) hideCommentPopup();
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
