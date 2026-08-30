import React, { useEffect, useRef, useState } from 'react'
import { AppProvider, useApp } from './AppContext'
import { ProjectPane } from '../project/ProjectPane'
import { EditorPane } from '../editor/EditorPane'
import { OverviewPane } from '../overview/OverviewPane'
import { TerminalPane } from '../terminal/TerminalPane'
import { FuzzyFileFinder } from '../search/FuzzyFileFinder'
import { ChangesOverlay } from '../changes/ChangesOverlay'
import { SettingsPanel } from '../settings/SettingsPanel'
import { EmptyState } from './EmptyState'
import { formatRelativeTime } from '../../shared/utils'

function Layout(): React.JSX.Element {
  const app = useApp()
  const [leftW, setLeftW] = useState(280)
  const [rightW, setRightW] = useState(320)
  const [bottomH, setBottomH] = useState(200)
  const dragging = useRef<string | null>(null)

  // restore pane sizes from settings
  useEffect(() => {
    if (app.settings) {
      setLeftW(app.settings.paneSizes.left)
      setRightW(app.settings.paneSizes.right)
      setBottomH(app.settings.paneSizes.bottom)
    }
  }, [app.settings?.paneSizes.left, app.settings?.paneSizes.right, app.settings?.paneSizes.bottom])

  // persist pane sizes (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      void app.updateSettings({ paneSizes: { left: leftW, right: rightW, bottom: bottomH } })
    }, 500)
    return () => clearTimeout(t)
  }, [leftW, rightW, bottomH])

  // global keyboard shortcuts: Ctrl+P, Ctrl+`, Ctrl+S
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'p') {
        e.preventDefault()
        app.setFuzzyOpen(true)
      } else if (k === '`') {
        e.preventDefault()
        app.toggleTerminal()
      } else if (k === 's') {
        e.preventDefault()
        void app.saveActive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app])

  // pane drag
  useEffect(() => {
    function onMove(e: MouseEvent): void {
      const d = dragging.current
      if (!d) return
      if (d === 'v1') setLeftW(Math.min(520, Math.max(180, e.clientX)))
      if (d === 'v2') setRightW(Math.min(620, Math.max(220, window.innerWidth - e.clientX)))
      if (d === 'h') setBottomH(Math.min(window.innerHeight * 0.7, Math.max(90, window.innerHeight - e.clientY)))
    }
    function onUp(): void {
      dragging.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div className="app-shell" style={{ ['--left-w' as string]: `${leftW}px`, ['--right-w' as string]: `${rightW}px`, ['--bottom-h' as string]: `${bottomH}px` }}>
      <div className="top-row">
        <div className="pane pane-left">
          <ProjectPane />
        </div>
        <div
          className="splitter splitter-v"
          onMouseDown={(e) => {
            dragging.current = 'v1'
            e.preventDefault()
          }}
        />
        <div className="pane pane-center">
          {app.projectRoot ? <EditorPane /> : <EmptyState />}
        </div>
        <div
          className="splitter splitter-v"
          onMouseDown={(e) => {
            dragging.current = 'v2'
            e.preventDefault()
          }}
        />
        <div className="pane pane-right">
          {app.projectRoot ? <OverviewPane /> : <div />}
        </div>
      </div>
      {app.terminalVisible && (
        <>
          <div
            className="splitter splitter-h"
            onMouseDown={(e) => {
              dragging.current = 'h'
              e.preventDefault()
            }}
          />
          <div className="pane-bottom">
            <TerminalPane />
          </div>
        </>
      )}
      <StatusBar />
      {app.fuzzyOpen && <FuzzyFileFinder />}
      {app.settingsOpen && <SettingsPanel />}
      {app.reviewRequest && <ChangesOverlay request={app.reviewRequest} />}
    </div>
  )
}

function StatusBar(): React.JSX.Element {
  const app = useApp()
  const ai = app.ai
  const dot = {
    connected: { color: 'var(--accent-2)' },
    connecting: { color: 'var(--warning)' },
    offline: { color: 'var(--danger)' },
    unconfigured: { color: 'var(--text-faint)' },
    error: { color: 'var(--danger)' }
  }[ai.status] ?? { color: 'var(--text-faint)' }
  const label = ai.status === 'connected' ? (ai.activeModel ?? 'AI') : ai.status

  const openInfo = app.activePath
    ? (() => {
        const buf = app.buffers[app.activePath]
        return buf ? `${app.activePath}${buf.dirty ? ' ●' : ''}` : app.activePath
      })()
    : null

  return (
    <div className="statusbar">
      <span>
        <span className="status-dot" style={{ background: dot.color }} />
        {ai.status === 'connected' ? (
          <span title={ai.error ?? ''}>{label}</span>
        ) : (
          <span title={ai.error ?? ''}>
            {ai.status === 'offline' || ai.status === 'error' ? 'AI unavailable' : 'AI connecting…'}
          </span>
        )}
      </span>
      <span className="spacer" />
      {app.aiWorking && <span className="ai-running" style={{ border: 'none', padding: 0 }}><span className="spinner" />{app.aiWorkingMessage || 'AI working…'}</span>}
      {openInfo && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>{openInfo}</span>}
      {app.projectOverview?.generatedAt ? (
        <span>overview {formatRelativeTime(app.projectOverview.generatedAt)}</span>
      ) : null}
      <span>CodeEater v{app.version}</span>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <Layout />
    </AppProvider>
  )
}