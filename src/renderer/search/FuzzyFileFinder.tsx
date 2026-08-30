import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../app/AppContext'
import { FileSearchResult } from '../../shared/types'

/**
 * Ctrl+P fuzzy file finder — deterministic, in-memory indexed, no AI.
 * Recently opened files get a mild ranking boost.
 */
export function FuzzyFileFinder(): React.JSX.Element {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileSearchResult[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!query.trim()) {
      setResults([])
      setCursor(0)
      return
    }
    timerRef.current = setTimeout(() => {
      void window.api.search.files(query, 60, app.tabs).then((r) => {
        setResults(r)
        setCursor(0)
      })
    }, 40)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query])

  function open(): void {
    const hit = results[cursor]
    if (!hit) return
    app.setFuzzyOpen(false)
    void app.openFile(hit.relPath)
  }

  return (
    <div className="overlay" onMouseDown={() => app.setFuzzyOpen(false)}>
      <div className="fuzzy-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              app.setFuzzyOpen(false)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(results.length - 1, c + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              open()
            }
          }}
          spellCheck={false}
        />
        <div className="fuzzy-list">
          {results.map((r, i) => (
            <div
              key={r.relPath}
              className={`fuzzy-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={open}
            >
              <span className="fuzzy-path">{r.relPath}</span>
              {app.tabs.includes(r.relPath) && <span style={{ fontSize: 10, opacity: 0.7 }}>open</span>}
            </div>
          ))}
          {results.length === 0 && query && (
            <div style={{ padding: 12, color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              no matches for “{query}”
            </div>
          )}
        </div>
      </div>
    </div>
  )
}