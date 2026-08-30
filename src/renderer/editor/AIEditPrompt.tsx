import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../app/AppContext'
import { SelectionSnapshot } from './CodeEditor'

type Mode = 'selection' | 'file' | 'codebase'

/**
 * The AI edit prompt in the center coding workflow.
 * Default scope: Selection when text is selected, otherwise File.
 * Codebase must be chosen explicitly. All proposals become Change Requests.
 */
export function AIEditPrompt({ selection }: { selection: SelectionSnapshot | null }): React.JSX.Element {
  const app = useApp()
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<Mode>('file')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const firstRender = useRef(true)

  // default scope follows selection
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (selection) setMode('selection')
    else if (mode === 'selection') setMode('file')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection !== null])

  const aiOff = app.ai.status === 'offline' || app.ai.status === 'unconfigured' || app.ai.status === 'error'

  async function submit(): Promise<void> {
    const p = prompt.trim()
    if (!p) return
    if (mode === 'selection' && !selection) {
      // selection mode requires an active selection; upgrade silently to file
      await app.runAiEdit({ mode: 'file', prompt: p })
    } else if (mode === 'selection') {
      await app.runAiEdit({
        mode: 'selection',
        prompt: p,
        selection: {
          startLine: selection!.startLine,
          endLine: selection!.endLine,
          text: selection!.text
        }
      })
    } else {
      await app.runAiEdit({ mode, prompt: p })
    }
    setPrompt('')
  }

  const scopeLabel =
    mode === 'selection'
      ? selection
        ? `Selection ${selection.startLine}–${selection.endLine}`
        : 'Selection (select code first)'
      : mode === 'file'
        ? 'File'
        : 'Codebase'

  return (
    <div className="ai-prompt-box">
      <textarea
        ref={taRef}
        placeholder={
          selection
            ? `✦ Describe a change to the selected code (${selection.startLine}–${selection.endLine})…`
            : '✦ Describe a change…'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        spellCheck={false}
      />
      <div className="ai-prompt-bar">
        <button
          className={`scope-btn${mode === 'selection' ? ' active' : ''}`}
          disabled={!selection}
          onClick={() => setMode('selection')}
          title="Edit the current selection"
        >
          Selection
        </button>
        <button className={`scope-btn${mode === 'file' ? ' active' : ''}`} onClick={() => setMode('file')}>
          File
        </button>
        <button
          className={`scope-btn${mode === 'codebase' ? ' active' : ''}`}
          onClick={() => setMode('codebase')}
          title="Explore the codebase read-only, then propose a plan"
        >
          Codebase
        </button>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{scopeLabel}</span>
        <button
          className="submit-btn primary"
          disabled={!prompt.trim() || app.aiWorking || aiOff}
          title={aiOff ? 'AI endpoint unavailable' : 'Generate a reviewable Change Request (Ctrl+Enter)'}
          onClick={() => void submit()}
        >
          ✦ Propose edit
        </button>
      </div>
      {app.aiWorking && (
        <div className="ai-running">
          <span className="spinner" />
          {app.aiWorkingMessage || 'Working…'} <span style={{ marginLeft: 'auto' }}>proposal → Change Request → review</span>
        </div>
      )}
      {aiOff && !app.aiWorking && (
        <div className="ai-running" style={{ color: 'var(--danger)' }}>
          AI unavailable ({app.ai.error ?? 'endpoint offline'}). Editing and search still work.
        </div>
      )}
    </div>
  )
}