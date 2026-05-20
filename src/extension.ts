import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
interface Note {
  id: string;
  text: string;
  done: boolean;
  priority: 'high' | 'medium' | 'low';
  tag: string;
  createdAt: string;
}

type Priority = 'high' | 'medium' | 'low';

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const MAX_NOTES = 200;
const MAX_NOTE_LENGTH = 5000;
const MAX_TAG_LENGTH = 20;
const VALID_PRIORITIES = new Set<Priority>(['high', 'medium', 'low']);
const VALID_COMMANDS = new Set(['ready', 'add', 'toggle', 'delete', 'clearDone']);

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Cryptographically random nonce — new one per webview render */
function getNonce(): string {
  return crypto.randomBytes(24).toString('base64');
}

/** Strip HTML special chars and allow only safe characters in a tag label */
function sanitizeTag(tag: unknown): string {
  if (typeof tag !== 'string') { return ''; }
  return tag
    .replace(/[<>"'&]/g, '')
    .replace(/[^\w\s\-]/g, '')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

/** Validate that a note ID is a numeric timestamp string */
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{1,16}$/.test(id);
}

/** Validate priority is one of the known values */
function isValidPriority(p: unknown): p is Priority {
  return typeof p === 'string' && VALID_PRIORITIES.has(p as Priority);
}

// ─────────────────────────────────────────────
//  Activate
// ─────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const provider = new DevNotesProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devNotesView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devNotes.addNote', () => provider.promptAddNote())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devNotes.clearDone', () => provider.clearDone())
  );
}

// ─────────────────────────────────────────────
//  Provider
// ─────────────────────────────────────────────
class DevNotesProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) { }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    // ── Security: no local resource access, scripts via nonce only ──
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []   // block webview from reading any local files
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // ── Secure message handler with full validation ──
    webviewView.webview.onDidReceiveMessage((msg) => {
      // 1. msg must be a plain object
      if (!msg || typeof msg !== 'object') { return; }

      // 2. command must be a known string
      if (typeof msg.command !== 'string') { return; }
      if (!VALID_COMMANDS.has(msg.command)) { return; }

      switch (msg.command) {
        case 'ready':
          this._sendNotes();
          break;

        case 'add':
          if (typeof msg.text !== 'string') { return; }
          if (msg.text.length === 0) { return; }
          if (msg.text.length > MAX_NOTE_LENGTH) { return; }
          if (!isValidPriority(msg.priority)) { return; }
          if (typeof msg.tag !== 'string') { return; }
          this._addNote(msg.text, msg.priority, msg.tag);
          break;

        case 'toggle':
          if (!isValidId(msg.id)) { return; }
          this._toggleNote(msg.id);
          break;

        case 'delete':
          if (!isValidId(msg.id)) { return; }
          this._deleteNote(msg.id);
          break;

        case 'clearDone':
          this._clearDone();
          break;
      }
    });
  }

  // ── Fallback: add note via VS Code input box (plain text) ──
  promptAddNote() {
    vscode.window.showInputBox({
      prompt: 'Enter your note / question',
      validateInput: (v) => v.length > MAX_NOTE_LENGTH ? `Max ${MAX_NOTE_LENGTH} characters` : null
    }).then((text) => {
      if (text && text.trim()) {
        this._addNote(this._escapeHtml(text.trim()), 'medium', '');
      }
    });
  }

  clearDone() { this._clearDone(); }

  // ─────────────────────────────────────────────
  //  Storage helpers
  // ─────────────────────────────────────────────
  private _getNotes(): Note[] {
    const notes = this.context.globalState.get<Note[]>('devNotes', []);
    // Extra safety: ensure it's actually an array
    return Array.isArray(notes) ? notes : [];
  }

  private _saveNotes(notes: Note[]) {
    this.context.globalState.update('devNotes', notes);
  }

  private _sendNotes() {
    this._view?.webview.postMessage({ command: 'load', notes: this._getNotes() });
  }

  // ─────────────────────────────────────────────
  //  Note operations
  // ─────────────────────────────────────────────
  private _addNote(text: string, priority: Priority, tag: string) {
    const notes = this._getNotes();

    if (notes.length >= MAX_NOTES) {
      vscode.window.showWarningMessage(
        `Dev Notes: limit of ${MAX_NOTES} notes reached. Delete some first.`
      );
      return;
    }

    notes.unshift({
      id: Date.now().toString(),
      text,                               // already sanitized by webview before sending
      done: false,
      priority,
      tag: sanitizeTag(tag),
      createdAt: new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    });

    this._saveNotes(notes);
    this._sendNotes();
  }

  private _toggleNote(id: string) {
    const notes = this._getNotes().map(n =>
      n.id === id ? { ...n, done: !n.done } : n
    );
    this._saveNotes(notes);
    this._sendNotes();
  }

  private _deleteNote(id: string) {
    this._saveNotes(this._getNotes().filter(n => n.id !== id));
    this._sendNotes();
  }

  private _clearDone() {
    this._saveNotes(this._getNotes().filter(n => !n.done));
    this._sendNotes();
  }

  // ─────────────────────────────────────────────
  //  Escape plain text → safe HTML (used in promptAddNote)
  // ─────────────────────────────────────────────
  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─────────────────────────────────────────────
  //  HTML — new nonce per render
  // ─────────────────────────────────────────────
  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>

<!-- ══ SECURITY: strict CSP ══
     • default-src 'none'  — block everything by default
     • script-src nonce    — only inline <script nonce="..."> allowed; no eval, no remote JS
     • style-src unsafe-inline — VS Code CSS vars need inline styles
     • No img-src, no connect-src, no frame-src
-->
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}';
  style-src 'unsafe-inline';
">

<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    min-height: 100vh;
  }

  /* ── Header ── */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border));
  }
  .header-left { display: flex; align-items: center; gap: 6px; }
  .header-title {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    opacity: 0.8;
  }
  .note-count {
    font-size: 10px; background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground); border-radius: 10px;
    padding: 1px 6px; font-weight: 600;
  }
  .header-actions { display: flex; gap: 4px; }
  .icon-btn {
    background: none; border: none; color: var(--vscode-foreground);
    opacity: 0.5; cursor: pointer; padding: 3px 5px; border-radius: 3px;
    font-size: 13px; line-height: 1; transition: opacity 0.15s, background 0.15s;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  /* ── Search ── */
  .search-wrap { padding: 8px 12px 6px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .search-input {
    width: 100%; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 4px 8px 4px 26px;
    font-size: 12px; font-family: inherit; outline: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: 8px center;
  }
  .search-input:focus { border-color: var(--vscode-focusBorder); outline: none; }

  /* ── Progress ── */
  .progress-wrap { padding: 4px 12px 2px; display: flex; align-items: center; gap: 8px; }
  .progress-track { flex: 1; height: 2px; border-radius: 1px; background: var(--vscode-widget-border, rgba(255,255,255,0.1)); overflow: hidden; }
  .progress-fill { height: 100%; background: #4ec9b0; border-radius: 1px; transition: width 0.3s ease; }
  .progress-text { font-size: 10px; opacity: 0.45; white-space: nowrap; }

  /* ── Add Form ── */
  .add-form {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
    display: flex; flex-direction: column; gap: 0;
  }
  .add-form.collapsed .form-extra,
  .add-form.collapsed .format-toolbar,
  .add-form.collapsed .note-editor,
  .add-form.collapsed .kbd-hint { display: none; }

  /* ── Format Toolbar ── */
  .format-toolbar {
    display: flex; align-items: center; gap: 1px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
    border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));
    border-radius: 4px 4px 0 0;
    padding: 3px 4px; flex-wrap: wrap; margin-top: 6px;
  }
  .fmt-btn {
    background: none; border: none; color: var(--vscode-foreground);
    cursor: pointer; padding: 3px 7px; border-radius: 3px;
    font-size: 12px; line-height: 1; opacity: 0.55;
    transition: opacity 0.12s, background 0.12s;
    font-family: inherit; min-width: 26px; text-align: center;
  }
  .fmt-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .fmt-btn.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.12)); color: var(--vscode-focusBorder, #3794ff); }
  .fmt-btn b   { font-weight: 700; }
  .fmt-btn i   { font-style: italic; }
  .fmt-btn u   { text-decoration: underline; }
  .fmt-btn s   { text-decoration: line-through; }
  .fmt-btn code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .fmt-divider { width: 1px; height: 14px; background: var(--vscode-widget-border, rgba(255,255,255,0.15)); margin: 0 3px; flex-shrink: 0; }

  /* ── Contenteditable editor ── */
  .note-editor {
    width: 100%; min-height: 64px; max-height: 160px; overflow-y: auto;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
    border-top: none; border-radius: 0 0 4px 4px;
    padding: 7px 8px; font-size: 12px; font-family: inherit;
    outline: none; line-height: 1.55; word-break: break-word;
  }
  .note-editor:focus { border-color: var(--vscode-focusBorder); }
  .note-editor:empty:before {
    content: attr(data-placeholder);
    color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6));
    pointer-events: none;
  }

  /* Rich text styles */
  .note-editor b, .note-text b { font-weight: 700; }
  .note-editor i, .note-text i { font-style: italic; }
  .note-editor u, .note-text u { text-decoration: underline; }
  .note-editor s, .note-text s { text-decoration: line-through; }
  .note-editor code, .note-text code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.08));
    padding: 1px 4px; border-radius: 3px;
  }
  .note-editor mark, .note-text mark { background: rgba(255,213,0,0.28); color: inherit; border-radius: 2px; padding: 0 2px; }
  .note-editor ul, .note-text ul,
  .note-editor ol, .note-text ol { padding-left: 16px; margin: 2px 0; }
  .note-editor li, .note-text li { margin: 1px 0; }

  .kbd-hint { font-size: 10px; opacity: 0.3; text-align: right; padding: 3px 2px 4px; }

  /* ── Form row ── */
  .form-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  select {
    flex: 1; background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
    border-radius: 4px; padding: 4px 6px; font-size: 11px; font-family: inherit; outline: none; cursor: pointer;
  }
  select:focus { border-color: var(--vscode-focusBorder); }
  .tag-input {
    flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 4px 8px; font-size: 11px; font-family: inherit; outline: none;
  }
  .tag-input:focus { border-color: var(--vscode-focusBorder); }
  .tag-input::placeholder { opacity: 0.5; }
  .btn-add {
  width: 100%;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 4px; padding: 7px 14px;
  font-size: 12px; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: background 0.15s, transform 0.1s; white-space: nowrap;
}
  .btn-add:hover { background: var(--vscode-button-hoverBackground); }
  .btn-add:active { transform: scale(0.97); }

  /* ── Filter bar ── */
  .filter-bar { display: flex; gap: 2px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .filter-tab {
    background: none; border: none; color: var(--vscode-foreground);
    opacity: 0.5; cursor: pointer; padding: 3px 8px; border-radius: 3px;
    font-size: 11px; font-family: inherit; transition: opacity 0.15s, background 0.15s;
  }
  .filter-tab:hover { opacity: 0.8; background: var(--vscode-toolbar-hoverBackground); }
  .filter-tab.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, var(--vscode-badge-background)); color: var(--vscode-badge-foreground); }

  /* ── Notes list ── */
  .notes-list { padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }

  /* ── Note card ── */
  .note-card {
    border-radius: 5px; overflow: hidden;
    border: 1px solid var(--vscode-widget-border, transparent);
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
    transition: border-color 0.15s; animation: slideIn 0.18s ease;
  }
  @keyframes slideIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
  .note-card:hover { border-color: var(--vscode-focusBorder); }
  .note-card.done { opacity: 0.45; }
  .note-card.done .note-text { text-decoration: line-through; }

  .priority-bar { height: 2px; width: 100%; }
  .priority-bar.high   { background: #f14c4c; }
  .priority-bar.medium { background: #cca700; }
  .priority-bar.low    { background: #3794ff; }

  .note-body { padding: 7px 10px 4px; }
  .note-top  { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
  .note-text { font-size: 12px; line-height: 1.5; flex: 1; word-break: break-word; }
  .note-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
  .note-time { font-size: 10px; opacity: 0.45; }
  .tag-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 0.8; }
  .priority-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
  .priority-dot.high   { background: #f14c4c; }
  .priority-dot.medium { background: #cca700; }
  .priority-dot.low    { background: #3794ff; }

  /* ── Action buttons ── */
  .note-actions { display: flex; gap: 4px; padding: 4px 8px 8px; justify-content: flex-end; }
  .action-btn {
    border: none; cursor: pointer; padding: 4px 10px; border-radius: 3px;
    font-size: 11px; font-weight: 600; font-family: inherit;
    transition: background 0.15s, transform 0.1s; white-space: nowrap;
  }
  .action-btn:active { transform: scale(0.96); }
  .action-btn.done-btn { background: rgba(78,201,176,0.15); color: #4ec9b0; border: 1px solid rgba(78,201,176,0.35); }
  .action-btn.done-btn:hover { background: rgba(78,201,176,0.28); }
  .action-btn.del-btn  { background: rgba(241,76,76,0.12);  color: #f14c4c; border: 1px solid rgba(241,76,76,0.3); }
  .action-btn.del-btn:hover  { background: rgba(241,76,76,0.25); }

  /* ── Empty state ── */
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 20px; text-align: center; opacity: 0.4; }
  .empty-icon  { font-size: 28px; }
  .empty-title { font-size: 12px; font-weight: 600; }
  .empty-sub   { font-size: 11px; }

  .section-label { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.4; padding: 6px 4px 2px; font-weight: 600; }

  .expand-hint {
    width: 100%; background: none;
    border: 1px dashed var(--vscode-input-border, rgba(255,255,255,0.1));
    border-radius: 4px; color: var(--vscode-foreground); opacity: 0.35;
    cursor: text; padding: 7px 10px; font-size: 12px; font-family: inherit;
    text-align: left; transition: opacity 0.15s;
  }
  .expand-hint:hover { opacity: 0.6; }
  .add-form:not(.collapsed) .expand-hint { display: none; }

  /* ── Char counter ── */
  .char-counter { font-size: 10px; opacity: 0.35; text-align: right; padding: 2px 2px 0; }
  .char-counter.warn  { opacity: 0.7; color: #cca700; }
  .char-counter.error { opacity: 1;   color: #f14c4c; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <span class="header-title">Dev Notes</span>
    <span class="note-count" id="note-count">0</span>
  </div>
  <div class="header-actions">
    <button class="icon-btn" title="Clear resolved notes" id="btn-clear">✓</button>
    <button class="icon-btn" title="Toggle editor"        id="btn-toggle">＋</button>
  </div>
</div>

<!-- Search -->
<div class="search-wrap">
  <input class="search-input" id="search" type="text" placeholder="Search notes…" autocomplete="off" spellcheck="false"/>
</div>

<!-- Progress -->
<div class="progress-wrap" id="progress-wrap" style="display:none">
  <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
  <span class="progress-text" id="progress-text">0 / 0 asked</span>
</div>

<!-- Add Form -->
<div class="add-form collapsed" id="add-form">

  <button class="expand-hint" id="expand-hint">Write a question or note…</button>

  <!-- Format toolbar -->
  <div class="format-toolbar">
    <button class="fmt-btn" title="Bold (Ctrl+B)"      data-cmd="bold"><b>B</b></button>
    <button class="fmt-btn" title="Italic (Ctrl+I)"    data-cmd="italic"><i>I</i></button>
    <button class="fmt-btn" title="Underline (Ctrl+U)" data-cmd="underline"><u>U</u></button>
    <button class="fmt-btn" title="Strikethrough"      data-cmd="strikeThrough"><s>S</s></button>
    <div class="fmt-divider"></div>
    <button class="fmt-btn" title="Inline code"        data-cmd="code"><code>&lt;/&gt;</code></button>
    <button class="fmt-btn" title="Highlight"          data-cmd="mark" style="font-size:13px">◨</button>
    <div class="fmt-divider"></div>
    <button class="fmt-btn" title="Bullet list"        data-cmd="insertUnorderedList">• —</button>
    <button class="fmt-btn" title="Numbered list"      data-cmd="insertOrderedList">1.</button>
    <div class="fmt-divider"></div>
    <button class="fmt-btn" title="Clear formatting"   data-cmd="removeFormat" style="font-size:11px">✕ fmt</button>
  </div>

  <div class="note-editor" id="editor" contenteditable="true"
    data-placeholder="Write a question or note… (Ctrl+Enter to save)"
    spellcheck="true"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 2px 4px;">
    <span class="kbd-hint">Ctrl+B bold · Ctrl+I italic · Ctrl+Enter save</span>
    <span class="char-counter" id="char-counter">0 / ${MAX_NOTE_LENGTH}</span>
  </div>

  <div class="form-row form-extra">
  <select id="priority" title="Priority">
    <option value="high">🔴 High</option>
    <option value="medium" selected>🟡 Medium</option>
    <option value="low">🔵 Low</option>
  </select>
  <input class="tag-input" id="tag" type="text" placeholder="Tag (e.g. meeting)" maxlength="${MAX_TAG_LENGTH}" autocomplete="off"/>
</div>
<div class="form-extra" style="margin-top:6px;">
  <button class="btn-add" id="btn-add" style="width:100%;padding:7px 14px;font-size:12px;">＋ Add Note</button>
</div>
</div>

<!-- Filter bar -->
<div class="filter-bar">
  <button class="filter-tab active" data-filter="all">All</button>
  <button class="filter-tab"        data-filter="open">Open</button>
  <button class="filter-tab"        data-filter="done">Asked</button>
  <button class="filter-tab"        data-filter="high">🔴</button>
</div>

<!-- Notes list -->
<div class="notes-list" id="notes-list"></div>

<!-- ══ SECURITY: nonce required — no eval, no inline handlers ══ -->
<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  let allNotes     = [];
  let currentFilter = 'all';

  // ── Constants (mirrored from extension) ──
  const MAX_NOTE_LENGTH = ${MAX_NOTE_LENGTH};
  const MAX_TAG_LENGTH  = ${MAX_TAG_LENGTH};
  const ALLOWED_TAGS    = new Set(['B','I','U','S','CODE','MARK','UL','OL','LI','BR','P','DIV','SPAN']);

  // ══════════════════════════════════════════
  //  SECURITY: HTML Sanitizer
  //  Strips any tag not in the allowlist and
  //  removes ALL attributes (no onclick, onerror,
  //  href, src, style, etc.)
  // ══════════════════════════════════════════
  function sanitizeHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    (function walk(node) {
      const children = Array.from(node.childNodes);
      children.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!ALLOWED_TAGS.has(child.tagName)) {
            // Replace disallowed element with its plain text
            const text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            // Strip every attribute — no exceptions
            Array.from(child.attributes).forEach(attr => child.removeAttribute(attr.name));
            walk(child);
          }
        }
      });
    })(tmp);

    return tmp.innerHTML;
  }

  // ── Safe plain-text escape for note display ──
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ══════════════════════════════════════════
  //  Message handler
  // ══════════════════════════════════════════
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || msg.command !== 'load' || !Array.isArray(msg.notes)) { return; }
    allNotes = msg.notes;
    applyFilters();
    updateProgress();
  });

  // Send ready after DOM is fully set up
  vscode.postMessage({ command: 'ready' });

  // ══════════════════════════════════════════
  //  Format toolbar — event delegation (no inline handlers)
  // ══════════════════════════════════════════
  document.querySelector('.format-toolbar').addEventListener('mousedown', e => {
    const btn = e.target.closest('.fmt-btn');
    if (!btn) { return; }
    e.preventDefault(); // keep editor focus

    const cmd = btn.dataset.cmd;
    if (!cmd) { return; }

    if (cmd === 'code') {
      fmtWrapTag('code');
    } else if (cmd === 'mark') {
      fmtWrapTag('mark');
    } else {
      const safe = ['bold','italic','underline','strikeThrough','insertUnorderedList','insertOrderedList','removeFormat'];
      if (safe.includes(cmd)) {
        document.execCommand(cmd, false, null);
      }
    }
    getEditor().focus();
    updateFmtState();
  });

  function fmtWrapTag(tag) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return; }
    const range    = sel.getRangeAt(0);
    const selected = range.toString();
    if (!selected) { return; }
    const el = document.createElement(tag);
    el.textContent = selected;
    range.deleteContents();
    range.insertNode(el);
    const newRange = document.createRange();
    newRange.selectNodeContents(el);
    newRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  function updateFmtState() {
    const cmds = ['bold','italic','underline','strikeThrough','insertUnorderedList','insertOrderedList'];
    document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
      const cmd = btn.dataset.cmd;
      if (cmds.includes(cmd)) {
        btn.classList.toggle('active', document.queryCommandState(cmd));
      }
    });
  }

  // ══════════════════════════════════════════
  //  Editor events
  // ══════════════════════════════════════════
  function getEditor() { return document.getElementById('editor'); }

  getEditor().addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); }
  });
  getEditor().addEventListener('input',    updateCharCounter);
  getEditor().addEventListener('mouseup',  updateFmtState);
  getEditor().addEventListener('keyup',    updateFmtState);

  document.getElementById('search').addEventListener('input', applyFilters);

  // ── Filter tabs ──
  document.querySelector('.filter-bar').addEventListener('click', e => {
    const tab = e.target.closest('.filter-tab');
    if (!tab) { return; }
    currentFilter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t === tab));
    applyFilters();
  });

  // ── Header buttons ──
  document.getElementById('btn-clear').addEventListener('click',  () => vscode.postMessage({ command: 'clearDone' }));
  document.getElementById('btn-toggle').addEventListener('click', toggleForm);
  document.getElementById('expand-hint').addEventListener('click', expandForm);
  document.getElementById('btn-add').addEventListener('click', addNote);

  // ── Note list (event delegation — handles all note buttons) ──
  document.getElementById('notes-list').addEventListener('click', e => {
    const btn = e.target.closest('.action-btn');
    if (!btn) { return; }
    const card = btn.closest('.note-card');
    if (!card) { return; }
    const id = card.dataset.id;
    if (!id || !/^\\d{1,16}$/.test(id)) { return; } // validate ID format

    if (btn.classList.contains('done-btn')) {
      vscode.postMessage({ command: 'toggle', id });
    } else if (btn.classList.contains('del-btn')) {
      vscode.postMessage({ command: 'delete', id });
    }
  });

  // ══════════════════════════════════════════
  //  Add note
  // ══════════════════════════════════════════
  function addNote() {
    const editor   = getEditor();
    const rawHtml  = editor.innerHTML.trim();
    const textOnly = editor.innerText.trim();

    if (!textOnly)                        { editor.focus(); return; }
    if (textOnly.length > MAX_NOTE_LENGTH){ return; } // hard client-side guard

    // Sanitize before sending to extension
    const cleanHtml = sanitizeHtml(rawHtml);

    const priorityEl = document.getElementById('priority');
    const tagEl      = document.getElementById('tag');
    const priority   = ['high','medium','low'].includes(priorityEl.value) ? priorityEl.value : 'medium';
    const tag        = tagEl.value.replace(/[<>"'&]/g, '').trim().slice(0, MAX_TAG_LENGTH);

    vscode.postMessage({ command: 'add', text: cleanHtml, priority, tag });

    editor.innerHTML  = '';
    tagEl.value       = '';
    updateCharCounter();
    editor.focus();
  }

  function updateCharCounter() {
    const len     = getEditor().innerText.trim().length;
    const counter = document.getElementById('char-counter');
    counter.textContent = len + ' / ' + MAX_NOTE_LENGTH;
    counter.className   = 'char-counter' +
      (len > MAX_NOTE_LENGTH * 0.9  ? ' error' :
       len > MAX_NOTE_LENGTH * 0.75 ? ' warn'  : '');
  }

  // ══════════════════════════════════════════
  //  UI state
  // ══════════════════════════════════════════
  function expandForm() {
    document.getElementById('add-form').classList.remove('collapsed');
    setTimeout(() => getEditor().focus(), 50);
  }

  function toggleForm() {
    const form = document.getElementById('add-form');
    form.classList.toggle('collapsed');
    if (!form.classList.contains('collapsed')) {
      setTimeout(() => getEditor().focus(), 50);
    }
  }

  function applyFilters() {
    const q = document.getElementById('search').value.toLowerCase();
    let notes = allNotes;
    if (currentFilter === 'open') { notes = notes.filter(n => !n.done); }
    if (currentFilter === 'done') { notes = notes.filter(n =>  n.done); }
    if (currentFilter === 'high') { notes = notes.filter(n => n.priority === 'high'); }
    if (q) {
      notes = notes.filter(n => {
        const tmp = document.createElement('div');
        tmp.innerHTML = n.text;
        return tmp.innerText.toLowerCase().includes(q) || (n.tag||'').toLowerCase().includes(q);
      });
    }
    render(notes);
    document.getElementById('note-count').textContent = notes.length;
  }

  function updateProgress() {
    const total = allNotes.length;
    const done  = allNotes.filter(n => n.done).length;
    const wrap  = document.getElementById('progress-wrap');
    if (total === 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    document.getElementById('progress-fill').style.width = (done / total * 100) + '%';
    document.getElementById('progress-text').textContent = done + ' / ' + total + ' asked';
  }

  // ══════════════════════════════════════════
  //  Render
  // ══════════════════════════════════════════
  function render(notes) {
    const list = document.getElementById('notes-list');
    if (!notes.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No notes here</div><div class="empty-sub">Add a question above to get started</div></div>';
      return;
    }
    const open = notes.filter(n => !n.done);
    const done = notes.filter(n =>  n.done);
    let html = '';
    if (open.length) { if (done.length) { html += '<div class="section-label">Open</div>'; } html += open.map(noteCard).join(''); }
    if (done.length) { html += '<div class="section-label">Asked</div>'; html += done.map(noteCard).join(''); }
    list.innerHTML = html;
  }

  function noteCard(n) {
    // Validate note shape defensively before rendering
    if (!n || typeof n.id !== 'string' || !/^\\d{1,16}$/.test(n.id)) { return ''; }
    const safePriority = ['high','medium','low'].includes(n.priority) ? n.priority : 'medium';
    const tagHtml      = n.tag ? '<span class="tag-badge">#' + esc(n.tag) + '</span>' : '';

    // n.text is stored as sanitized HTML; safe to render
    const isHtml = /<[a-z][\\s\\S]*>/i.test(n.text);
    const body   = isHtml ? n.text : esc(n.text);

    return '<div class="note-card ' + (n.done ? 'done' : '') + '" data-id="' + esc(n.id) + '">' +
      '<div class="priority-bar ' + safePriority + '"></div>' +
      '<div class="note-body">' +
        '<div class="note-top">' +
          '<div class="note-text">' + body + '</div>' +
          '<div class="priority-dot ' + safePriority + '"></div>' +
        '</div>' +
        '<div class="note-meta">' +
          '<span class="note-time">' + esc(n.createdAt) + '</span>' +
          tagHtml +
        '</div>' +
      '</div>' +
      '<div class="note-actions">' +
        '<button class="action-btn done-btn">' + (n.done ? '↩ Undo' : '✓ Mark Asked') + '</button>' +
        '<button class="action-btn del-btn">✕ Delete</button>' +
      '</div>' +
    '</div>';
  }

})(); // end IIFE — no globals leaked
</script>
</body>
</html>`;
  }
}

export function deactivate() { }