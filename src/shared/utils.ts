/** Shared deterministic helpers (no I/O). */

import type { KeybindingMap } from './types'

// ---------------------------------------------------------------------------
// Keybindings (platform-aware, shared between main & renderer)
// ---------------------------------------------------------------------------

export function isMacPlatform(): boolean {
  if (typeof process !== 'undefined' && process.platform) return process.platform === 'darwin'
  if (typeof navigator !== 'undefined') return /Mac|iPhone|iPad/.test(navigator.platform ?? '')
  return false
}

/** Default keybinding map — ⌘ on macOS, Ctrl elsewhere. */
export function defaultKeybindings(): KeybindingMap {
  const mac = isMacPlatform()
  return {
    findFile: mac ? 'meta+p' : 'ctrl+p',
    toggleTerminal: 'ctrl+`',
    saveFile: mac ? 'meta+s' : 'ctrl+s',
    openPreferences: mac ? 'meta+,' : 'ctrl+,',
    closeTab: mac ? 'meta+w' : 'ctrl+w',
    newTerminal: mac ? 'meta+shift+`' : 'ctrl+shift+`'
  }
}

/** e.key name used in combos (normalized lowercase, renamed specials). */
function keyName(key: string): string {
  if (key === ' ') return 'space'
  const lower = key.toLowerCase()
  if (lower === 'escape') return 'esc'
  if (lower === 'control') return 'ctrl'
  if (lower === 'meta') return 'meta'
  if (lower === 'shift') return 'shift'
  if (lower === 'alt') return 'alt'
  if (lower === 'arrowup') return 'up'
  if (lower === 'arrowdown') return 'down'
  if (lower === 'arrowleft') return 'left'
  if (lower === 'arrowright') return 'right'
  if (lower === ' ') return 'space'
  return lower
}

/** Minimal structural KeyboardEvent — DOM KeyboardEvent satisfies this, and it keeps main-process builds DOM-free. */
export interface KeyComboEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Build a canonical combo string from a KeyboardEvent (e.g. "ctrl+shift+p"). */
export function comboFromEvent(e: KeyComboEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(keyName(e.key))
  return parts.join('+')
}

function keysEqual(comboKey: string, eventKey: string): boolean {
  const a = comboKey.toLowerCase()
  const b = keyName(eventKey)
  if (a === 'space' && b === 'space') return true
  if (a === 'esc' && b === 'esc') return true
  return a === b
}

/** True when the event matches a stored combo (exact modifier set). */
export function comboMatches(e: KeyComboEvent, combo: string): boolean {
  const parts = combo.trim().toLowerCase().split('+').filter(Boolean)
  if (parts.length === 0) return false
  const keyPart = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const pressed = new Set<string>()
  if (e.ctrlKey) pressed.add('ctrl')
  if (e.metaKey) pressed.add('meta')
  if (e.altKey) pressed.add('alt')
  if (e.shiftKey) pressed.add('shift')
  for (const m of mods) if (!pressed.has(m)) return false
  for (const m of pressed) if (!mods.has(m)) return false
  return keysEqual(keyPart, e.key)
}

/** Which command (if any) a KeydownEvent maps to under the given bindings. */
export function matchCombo(e: KeyComboEvent, kb: KeybindingMap): keyof KeybindingMap | null {
  const entries = Object.entries(kb) as [keyof KeybindingMap, string][]
  for (const [id, combo] of entries) {
    if (combo && comboMatches(e, combo)) return id
  }
  return null
}

/** Human-readable display of a combo, e.g. "ctrl+`" → "Ctrl+`", "meta+s" → "⌘S". */
export function formatCombo(combo: string | undefined): string {
  if (!combo) return ''
  const mac = isMacPlatform()
  const labels: Record<string, string> = {
    ctrl: 'Ctrl',
    meta: mac ? '⌘' : 'Super',
    alt: mac ? '⌥' : 'Alt',
    shift: mac ? '⇧' : 'Shift',
    space: 'Space',
    esc: 'Esc',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→'
  }
  const seps = mac ? '' : '+'
  return combo
    .split('+')
    .filter(Boolean)
    .map((p) => labels[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join(seps)
}

/** Default directories ignored by the project tree and indexer. */
export const DEFAULT_IGNORED_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  'target',
  '.turbo',
  '.swc',
  '.parcel-cache',
  'bower_components',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.DS_Store'
]

export function isIgnored(relPath: string, ignoredDirs: string[] = DEFAULT_IGNORED_DIRS): boolean {
  const parts = relPath.split('/')
  return parts.some((p) => ignoredDirs.includes(p))
}

/** sha256 hex digest of a string. */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Cheap token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Language id for syntax highlighting / tree-sitter from a file path. */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    java: 'java',
    cs: 'csharp',
    kt: 'kotlin',
    php: 'php',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    vue: 'vue',
    svelte: 'svelte',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    r: 'r',
    elm: 'elm',
    elixir: 'ex',
    exs: 'ex',
    solidity: 'solidity',
    scala: 'scala',
    zig: 'zig'
  }
  return map[ext] ?? 'plaintext'
}

/** tree-sitter wasm grammar name for a language id (null → no grammar available). */
export function tsGrammarForLanguage(lang: string): string | null {
  const map: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'javascript',
    tsx: 'tsx',
    jsx: 'javascript',
    json: 'json',
    python: 'python',
    ruby: 'ruby',
    rust: 'rust',
    go: 'go',
    c: 'c',
    cpp: 'cpp',
    java: 'java',
    csharp: 'c_sharp',
    kotlin: 'kotlin',
    php: 'php',
    css: 'css',
    html: 'html',
    vue: 'vue',
    yaml: 'yaml',
    toml: 'toml',
    bash: 'bash',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    elixir: 'elixir',
    scala: 'scala',
    solidity: 'solidity',
    zig: 'zig'
  }
  return map[lang] ?? null
}

/** Split text into lines keeping original line endings normalized to \n. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Join lines (inverse of splitLines). */
export function joinLines(lines: string[]): string {
  return lines.join('\n')
}

/** Extract slice of a file by 1-based inclusive line range. */
export function sliceLines(text: string, startLine: number, endLine: number): string {
  const lines = splitLines(text)
  const s = Math.max(1, startLine)
  const e = Math.min(lines.length, endLine)
  if (s > e) return ''
  return lines.slice(s - 1, e).join('\n')
}