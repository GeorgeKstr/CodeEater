import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../app/AppContext'
import { formatCombo, defaultKeybindings } from '../../shared/utils'
import { CodeEditor, SelectionSnapshot } from './CodeEditor'
import { AIEditPrompt } from './AIEditPrompt'

export function EditorPane(): React.JSX.Element {
  const app = useApp()
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null)
  const saveLastRef = useRef<string>('')

  // persist tab state when it changes
  useEffect(() => {
    const key = app.tabs.join(',') + '|' + (app.activePath ?? '')
    if (key !== saveLastRef.current) {
      saveLastRef.current = key
      void window.api.project.setTabs(app.tabs, app.activePath)
    }
  }, [app.tabs, app.activePath])

  if (!app.activePath) {
    return (
      <div className="editor-pane">
        <div className="empty-state">
          <div className="big">No file open</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            Click a file in the project tree, or press <span className="kbd">{formatCombo(app.settings?.keybindings?.findFile ?? defaultKeybindings().findFile)}</span>
          </div>
        </div>
      </div>
    )
  }

  const active = app.buffers[app.activePath]

  return (
    <div className="editor-pane">
      <div className="tabbar">
        {app.tabs.map((t) => {
          const buf = app.buffers[t]
          const name = t.split('/').pop() ?? t
          return (
            <div
              key={t}
              className={`tab${t === app.activePath ? ' active' : ''}`}
              onClick={() => app.activateTab(t)}
              onAuxClick={(e) => {
                if (e.button === 1) void app.closeTab(t)
              }}
              title={t}
            >
              <span className="name">{name}</span>
              {buf?.dirty ? <span className="dot" /> : null}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  void app.closeTab(t)
                }}
              >
                ✕
              </span>
            </div>
          )
        })}
        <div className="tabbar-right">
          <AiBadge />
          <button
            style={{ fontSize: 11, padding: '2px 9px' }}
            disabled={!active?.dirty}
            onClick={() => void app.saveActive()}
          >
            Save
          </button>
        </div>
      </div>
      <div className="editor-host">
        <CodeEditor onSelectionChange={setSelection} />
      </div>
      <AIEditPrompt selection={selection} />
    </div>
  )
}

function AiBadge(): React.JSX.Element {
  const app = useApp()
  const on = app.ai.status === 'connected'
  return (
    <span className={`ai-badge ${on ? 'on' : 'off'}`} title={app.ai.status === 'connected' ? app.ai.activeModel ?? '' : app.ai.error ?? 'AI unavailable — editor works offline'}>
      ✦ {on ? 'AI' : 'AI offline'}
    </span>
  )
}