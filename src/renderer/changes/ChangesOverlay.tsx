import React, { useEffect, useState } from 'react'
import * as monaco from 'monaco-editor'
import { useApp } from '../app/AppContext'
import { ChangeRequest } from '../../shared/types'
import { languageFromPath } from '../../shared/utils'

/**
 * Change Request review: summary, per-file diff stats, Accept/Reject/Revert.
 * Clicking a file opens the Monaco DiffEditor (ORIGINAL | PROPOSED).
 */

export function ChangesOverlay({ request }: { request: ChangeRequest }): React.JSX.Element {
  const app = useApp()
  const [diff, setDiff] = useState<{ path: string; original: string; proposed: string; state: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<ChangeRequest>(request)

  useEffect(() => {
    setLive(request)
    setDiff(null)
  }, [request])

  const pending = live.status === 'pending'
  const accepted = live.status === 'accepted'

  async function act(fn: () => Promise<ChangeRequest>): Promise<void> {
    setBusy(true)
    try {
      const updated = await fn()
      setLive(updated)
      void app.refreshChanges()
      if (updated.status === 'accepted' || updated.status === 'reverted') {
        // editor buffers may be stale after apply — trigger reload via watcher
        setDiff(null)
      }
    } catch (e) {
      window.alert(`Change request action failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="overlay" onMouseDown={() => app.setReviewRequest(null)}>
        <div
          className="fuzzy-box"
          style={{ marginTop: '6vh', width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ fontSize: 13, flex: 1 }}>CHANGE REQUEST</h3>
              <span className={`cr-status ${live.status}`}>{live.status.toUpperCase()}</span>
              <button style={{ padding: '1px 8px' }} onClick={() => app.setReviewRequest(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, marginTop: 6, color: 'var(--text)' }}>“{live.prompt}”</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
              scope: {live.scope} · {live.summary}
            </div>
          </div>

          <div className="cr-files" style={{ overflow: 'auto', flex: 1 }}>
            {live.files.map((f) => {
              const isNew = f.operation === 'create'
              const isDel = f.operation === 'delete'
              return (
                <div
                  key={f.path}
                  className={`cr-file${isNew ? ' new' : ''}${isDel ? ' del' : ''}`}
                  onClick={() => setDiff({ path: f.path, original: f.originalContent ?? '', proposed: f.proposedContent ?? '', state: f.state })}
                >
                  <span>{isNew ? '✦ ' : isDel ? '✕ ' : ''}{f.path}</span>
                  <span className="stat">
                    {isNew ? 'NEW' : isDel ? 'DELETE' : diffStat(f.originalContent ?? '', f.proposedContent ?? '')}
                  </span>
                </div>
              )
            })}
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', padding: '8px 2px 2px' }}>
              {live.files.some((f) => f.state === 'stale') ? '⚠ some files changed on disk since proposal' : ''}
              {live.error ? ` ⚠ ${live.error}` : ''}
            </div>
          </div>

          <div className="cr-actions">
            {pending && (
              <>
                <button className="danger" disabled={busy} onClick={() => void act(() => window.api.changes.reject(live.id))}>
                  Reject
                </button>
                <button className="primary" disabled={busy} onClick={() => void act(() => window.api.changes.apply(live.id))}>
                  Accept & Apply
                </button>
              </>
            )}
            {accepted && (
              <>
                <span className="warn">Applied. Revert restores the pre-change state.</span>
                <button className="danger" disabled={busy} onClick={() => void act(() => window.api.changes.revert(live.id))}>
                  ⤺ Revert
                </button>
              </>
            )}
            {!pending && !accepted && (
              <button onClick={() => app.setReviewRequest(null)}>Close</button>
            )}
          </div>
        </div>
      </div>
      {diff && (
        <DiffViewer
          path={diff.path}
          original={diff.original}
          proposed={diff.proposed}
          state={diff.state}
          onClose={() => setDiff(null)}
        />
      )}
    </>
  )
}

function diffStat(original: string, proposed: string): string {
  if (!original && proposed) return `+${proposed.split(/\r?\n/).length}`
  const o = original.split(/\r?\n/)
  const p = proposed.split(/\r?\n/)
  // simple 3-line prefix alignment for a rough stat
  let prefix = 0
  const maxPre = Math.min(o.length, p.length)
  while (prefix < maxPre && o[prefix] === p[prefix]) prefix++
  let added = 0
  let removed = 0
  for (let i = prefix; i < p.length; i++) {
    const op = i - prefix < o.length - prefix ? o[i] : undefined
    if (op === undefined) added++
    else if (op !== p[i]) {
      added++
      removed++
    }
  }
  removed += Math.max(0, o.length - prefix - p.length + prefix)
  return `+${added} -${removed}`
}

export function DiffViewer({
  path,
  original,
  proposed,
  state,
  onClose
}: {
  path: string
  original: string
  proposed: string
  state: string
  onClose: () => void
}): React.JSX.Element {
  const [lang, setLang] = useState(monacoLanguageFromPath(path))
  useEffect(() => {
    setLang(monacoLanguageFromPath(path))
  }, [path])
  void state
  return (
    <div className="diff-host">
      <div className="diff-head">
        <span style={{ color: 'var(--text-faint)' }}>ORIGINAL</span>
        <span>⟷</span>
        <span style={{ color: 'var(--text-faint)' }}>PROPOSED</span>
        <span style={{ marginLeft: 'auto' }}>{path}</span>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="diff-body">
        <DiffEditorInner original={original} proposed={proposed} language={lang} />
      </div>
    </div>
  )
}

function DiffEditorInner({ original, proposed, language }: { original: string; proposed: string; language: string }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 30)
    return () => clearTimeout(t)
  }, [])
  if (!ready) return <div />
  return (
    <MonacoDiff original={original} modified={proposed} language={language} />
  )
}

// small wrapper around the DiffEditor with a stable key
function MonacoDiff({ original, modified, language }: { original: string; modified: string; language: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const editor = monaco.editor.createDiffEditor(ref.current, {
      automaticLayout: true,
      theme: 'vs-dark',
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      fontFamily: "var(--mono)"
    })
    editorRef.current = editor
    editor.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language)
    })
    return () => {
      editor.getModel()?.original.dispose()
      editor.getModel()?.modified.dispose()
      editor.dispose()
      editorRef.current = null
    }
  }, [original, modified, language])
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />
}

function monacoLanguageFromPath(path: string): string {
  const lang = languageFromPath(path)
  const map: Record<string, string> = {
    typescript: 'typescript', javascript: 'javascript', json: 'json', python: 'python',
    rust: 'rust', go: 'go', c: 'c', cpp: 'cpp', java: 'java', css: 'css', html: 'html',
    markdown: 'markdown', yaml: 'yaml', toml: 'ini', shell: 'shell', sql: 'sql', ruby: 'ruby',
    csharp: 'csharp', php: 'php'
  }
  return map[lang] ?? 'plaintext'
}