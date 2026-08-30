# CodeEater

An AI-native code editor focused on fast project navigation, concise AI-assisted understanding, and **safe** AI-driven code modification.

- Desktop shell: **Electron**
- UI: **React + TypeScript (Vite)**
- Editor: **Monaco Editor** (including DiffEditor for change review)
- Terminal: **xterm.js + node-pty**
- Parsing: **tree-sitter** (WASM grammars)
- Fast search: **ripgrep** (deterministic), fuzzy in-memory file index
- Persistence: **SQLite** (project index + AI artifact cache + change request history + sessions)
- AI: **OpenAI-compatible local endpoint** — LM Studio / llama.cpp server are the primary targets

The editor uses whichever model the endpoint has loaded. It never bundles a model and never depends on a specific model family. The editor is fully usable when the AI endpoint is offline.

## Layout

```
┌──────────────────┬─────────────────────────────────┬────────────────────────┐
│ Search...    [AI]│                                 │ PROJECT │ FILE         │
│ PROJECT TREE     │          CODE EDITOR            │       OVERVIEW         │
├──────────────────┴─────────────────────────────────┴────────────────────────┤
│  bash | bash 2 | +                                        TERMINAL   Ctrl+`   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Getting started

```bash
npm install
npm run dev          # electron-vite dev (HMR)
npm run build        # production build
npm start            # run the built app
npm run typecheck
```

## Install from GitHub (one script, any platform)

The repo is private, so the installer uses your existing GitHub access
(SSH keys or `gh auth`).

**Linux / macOS — `scripts/install.sh`:**

```bash
# recommended: clone, then install (uses your SSH key)
git clone git@github.com:GeorgeKstr/CodeEater.git && cd CodeEater
./scripts/install.sh

# or install straight from GitHub into ~/.local/share/codeeater
./scripts/install.sh --github --branch master

# once the repo is public, a single pipe works on any Unix:
curl -fsSL https://raw.githubusercontent.com/GeorgeKstr/CodeEater/master/scripts/install.sh | bash
```

**Windows — `scripts/install.ps1`:**

```powershell
git clone git@github.com:GeorgeKstr/CodeEater.git
cd CodeEater
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# public one-liner:
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/GeorgeKstr/CodeEater/master/scripts/install.ps1 | iex"
```

The installer checks prerequisites (node ≥ 18, npm, python3, make/C-compiler, git),
installs what it can (nvm / apt / dnf / pacman / brew), pulls the repo, runs
`npm install` + `npm run build` (node-pty and better-sqlite3 are rebuilt for
Electron), and sets up the `coe` command + desktop shortcut/icon.

Use `scripts/install.sh --uninstall` (or `scripts/install.ps1 -Uninstall`) to remove it.

- Open a project: **Open Project…** button (or pick a recent project), or the native **File ▸ Open Project…** menu.
- `Ctrl+P` — fuzzy file finder (deterministic, no AI)
- `` Ctrl+` `` — toggle terminal (background sessions keep running while hidden)
- `Ctrl+Shift+` `` — new terminal tab
- `Ctrl+S` — save
- **File ▸ Preferences…** (or `Ctrl+,`) — settings panel with **Hotkeys** (rebind everything above), **Terminal** (font size, family, scrollback) and **AI** sections.
- Left pane: deterministic codebase search (ripgrep). Press **AI** to search for *where a concept is likely implemented*.
- Right pane: **PROJECT** (summary, running guide, features, recent work) and **FILE** (summary, semantic sections, related files).
- Bottom of the editor: the AI edit prompt with **Selection / File / Codebase** scopes.

## AI configuration

Open the settings panel (gear icon in the bottom-right of the window) to set:

| Setting | Default |
| --- | --- |
| AI Endpoint | `http://localhost:1234/v1` |
| Model Mode | Auto (uses whatever model the endpoint has loaded) |
| Context Window | 32768 tokens |
| Status | shows connection/model state |

Cached AI analysis (project/file overviews) is stored per project in SQLite (`userData/projects/<hash>/index.db`).

## Critical architectural rule

> **The LLM is a reasoning and proposal engine. The deterministic editor is the authority on files, project structure, search, paths, locations, application state, patches, diffs, validation, and whether any modification is actually applied.**

The architecture never allows:

```text
LLM → direct filesystem mutation
```

The required flow is:

```text
LLM
 ↓
structured proposal
 ↓
validation
 ↓
Change Request
 ↓
user review
 ↓
deterministic application
```

## Critical AI context rule

AI context is **retrieved, never dumped**. All project-wide AI features follow:

```text
deterministic project index
↓
retrieve likely relevant files/chunks
↓
build bounded context (token budget)
↓
AI reasoning
```

## Change Requests (all AI edits)

Every AI-generated modification becomes a reviewable **Change Request**:

1. The AI proposes structured edits (`replace` / `insert` / `create` / `delete`).
2. Edits are validated: paths inside the project root, targets exist, line ranges valid, no overlaps.
3. The change request shows per-file `ORIGINAL | PROPOSED` diffs (Monaco DiffEditor).
4. **Accept** applies atomically after hash verification — a file changed on disk since the proposal is never silently overwritten (marked `conflicted` instead).
5. **Reject** touches nothing.
6. Accepted requests can be **reverted** via inverse application, with the same conflict checks. Revert is separate from `Ctrl+Z` and from git.

## Deterministic facts vs AI assumptions

The application tracks this distinction explicitly:

- **Deterministic**: file exists, text occurs on line N, file imports another file, symbol exists, function begins at line N — from the project index (SQLite), the filesystem, and ripgrep.
- **AI assumptions**: "this file appears to implement authentication", "this feature likely spans these files". AI-searched paths and line numbers are validated against the real project before navigation is allowed.

## Module map (conceptual boundaries)

```text
src/main        Electron main: filesystem, watcher, SQLite, node-pty, ripgrep,
                tree-sitter indexing, AI HTTP networking, Change Request engine
src/preload     typed IPC bridge (contextBridge)
src/renderer    React UI: panes, Monaco, overviews, terminal, change review
src/core        deterministic editor logic (index, search, patcher, sessions)
src/ai          model gateway, context builder, operations, schemas, caching
src/shared      the typed contract between main and renderer
```

## Operations (AI features)

- `project-overview` — project summary + running guide + feature detection
- `feature-resolution` — deterministic candidate discovery → AI maps feature to files/locations
- `file-overview` — file summary, semantic TOC sections, related files
- `ai-search-expand` / `ai-search-final` — query expansion → deterministic retrieval → ranking → AI reasoning → validated results
- `selection-edit` / `file-edit` / `codebase-plan` / `codebase-edit` — AI edit proposals
- `session-summary` — summarizes *recorded* editor sessions (never inferred from nothing)

All structured output is validated against JSON schemas; one repair attempt is made on failure, then the operation fails gracefully. AI analysis is cached and invalidated per-file.

## Development notes

- `CODEEATER_DEBUG=1` logs renderer console messages + captures a screenshot to `userData`.
- Native modules: `node-pty`, `better-sqlite3` (rebuild via `npm run postinstall` when Electron ABI changes).