import React, { useState } from 'react'
import { useApp } from '../app/AppContext'
import { ProjectTree, projectTreeSummary } from './ProjectTree'
import { formatRelativeTime } from '../../shared/utils'

/**
 * Left pane: project tree + deterministic global search + AI semantic search.
 * Search and tree toggle by which results are displayed.
 */

export function ProjectPane(): React.JSX.Element {
  const app = useApp()
  const [showAi, setShowAi] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)

  const searching = searchFocused || app.searchQuery.length > 0 || app.aiSearch !== null

  async function onAiClick(): Promise<void> {
    setShowAi(true)
    await app.runAiSearch(app.searchQuery)
    setShowAi(false)
  }

  return (
    <>
      <div className="left-search">
        <input
          placeholder="Search codebase…"
          value={app.searchQuery}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
          onChange={(e) => app.setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void app.runTextSearch(app.searchQuery)
            if (e.key === 'Escape') app.setSearchQuery('')
          }}
          spellCheck={false}
        />
        <button
          className={`ai-search-btn${showAi || app.aiSearch?.loading ? ' active' : ''}`}
          disabled={
            !app.searchQuery.trim() ||
            app.ai?.status === 'offline' ||
            app.ai?.status === 'unconfigured' ||
            app.aiSearch?.loading === true
          }
          title="AI semantic search — where is this concept implemented?"
          onClick={() => void onAiClick()}
        >
          ✦ AI
        </button>
      </div>

      {!searching || (!app.searchQuery && !app.aiSearch) ? (
        <div className="tree-scroll">
          <ProjectTree />
          <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>
            {projectTreeSummary(app.tree)}
          </div>
        </div>
      ) : app.aiSearch ? (
        <AiSearchResults />
      ) : (
        <TextSearchResults />
      )}
    </>
  )
}

function TextSearchResults(): React.JSX.Element {
  const app = useApp()
  const results = app.textResults
  if (!results) {
    return <div className="search-results"><div className="sr-header">type to search…</div></div>
  }
  if (results.length === 0) {
    return (
      <div className="search-results">
        <div className="sr-header">No matches for “{app.searchQuery}”</div>
      </div>
    )
  }
  return (
    <div className="search-results">
      <div className="sr-header">
        <span>{results.length} matches for “{app.searchQuery}”</span>
        <span style={{ marginLeft: 'auto' }}>deterministic</span>
      </div>
      <div className="sr-list">
        {results.map((r, i) => (
          <div
            key={`${r.relPath}:${r.line}:${i}`}
            className="sr-item"
            onClick={() => {
              void app.openFile(r.relPath)
              app.requestReveal(r.relPath, r.line, r.line, r.lineText)
            }}
          >
            <div className="path-line">
              <span>{r.relPath}</span>
              <span style={{ color: 'var(--text-faint)' }}>{r.line}</span>
            </div>
            <div className="match-line">{r.lineText}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AiSearchResults(): React.JSX.Element {
  const app = useApp()
  const s = app.aiSearch!
  if (s.loading) {
    return (
      <div className="search-results">
        <div className="sr-header">
          <span className="spinner" />
          {s.status || 'Searching…'}
          <button
            style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 8px' }}
            onClick={() => app.cancelAiSearch()}
          >
            cancel
          </button>
        </div>
      </div>
    )
  }
  const results = s.result
  if (!results) {
    return (
      <div className="search-results">
        <div className="sr-header">{s.status || 'No result'}</div>
      </div>
    )
  }
  return (
    <div className="search-results">
      <div className="sr-header">
        <span>AI search: “{s.query}”</span>
        <span style={{ marginLeft: 'auto' }}>semantic</span>
      </div>
      <div className="sr-list">
        {results.summary && (
          <div style={{ padding: '6px 8px', fontSize: 11.5, color: 'var(--text-dim)', borderBottom: '1px solid var(--border-soft)' }}>
            {results.summary}
          </div>
        )}
        {results.results.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>
            No likely implementation found. Try different wording.
          </div>
        )}
        {results.results.map((r, i) => (
          <div
            key={i}
            className="sr-item"
            onClick={() => {
              void app.openFile(r.relPath)
              if (r.startLine) app.requestReveal(r.relPath, r.startLine, r.endLine ?? r.startLine)
            }}
          >
            <div className="path-line">
              <span>{r.relPath}</span>
              {r.startLine ? (
                <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
                  {r.startLine}{r.endLine && r.endLine !== r.startLine ? `–${r.endLine}` : ''}
                </span>
              ) : null}
            </div>
            <div className="reason">{r.reason}</div>
          </div>
        ))}
        <div style={{ padding: '8px', fontSize: 10.5, color: 'var(--text-faint)' }}>
          AI results are suggestions — validated against the real project but always verify.
        </div>
      </div>
    </div>
  )
}

void formatRelativeTime