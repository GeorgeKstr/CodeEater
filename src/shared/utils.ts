/** Shared deterministic helpers (no I/O). */

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