import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useApp } from '../app/AppContext'
import { formatCombo, defaultKeybindings } from '../../shared/utils'
import type { TerminalSessionInfo } from '../../shared/types'

/**
 * Bottom terminal pane: xterm.js here, node-pty in main.
 * Each tab = one pty session. Hiding the pane never kills processes —
 * sessions keep running until their tab is closed (✕) or the app quits.
 */

export function TerminalPane(): React.JSX.Element {
  const app = useApp()
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const termsRef = useRef<Record<string, Terminal>>({})
  const fitsRef = useRef<Record<string, FitAddon>>({})
  const hostRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const cleanupsRef = useRef<Record<string, () => void>>({})

  const termPrefs = app.settings?.terminal

  // ------------------------------------------------------------------ list
  async function refresh(): Promise<void> {
    try {
      const list = await window.api.terminal.list()
      setSessions(list)
      setActiveId((prev) =>
        prev && list.some((s) => s.id === prev) ? prev : list[list.length - 1]?.id ?? null
      )
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const offData = window.api.terminal.onData((id, data) => {
      termsRef.current[id]?.write(data)
    })
    const offExit = window.api.terminal.onExit(() => {
      void refresh()
    })
    const offChanged = window.api.terminal.onListChanged(() => void refresh())
    void refresh()
    return () => {
      offData()
      offExit()
      offChanged()
    }
  }, [])

  // ------------------------------------------------------------- xterm init
  function initTerm(id: string): void {
    const host = hostRefs.current[id]
    if (!host || termsRef.current[id]) return
    const prefs = termPrefs
    const term = new Terminal({
      fontSize: prefs?.fontSize ?? 12,
      fontFamily: prefs?.fontFamily && prefs.fontFamily.trim() ? prefs.fontFamily : undefined,
      theme: { background: '#141519', foreground: '#d7dae0', cursor: '#d7dae0' },
      scrollback: prefs?.scrollback ?? 5000,
      convertEol: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termsRef.current[id] = term
    fitsRef.current[id] = fit

    const onKeySub = term.onData((data) => void window.api.terminal.write(id, data))
    const doResize = (): void => {
      fit.fit()
      void window.api.terminal.resize(id, term.cols, term.rows)
    }
    doResize()
    const observer = new ResizeObserver(() => doResize())
    observer.observe(host)
    void window.api.terminal.activate(id)

    const cleanup = (): void => {
      onKeySub.dispose()
      observer.disconnect()
      term.dispose()
      delete termsRef.current[id]
      delete fitsRef.current[id]
      delete cleanupsRef.current[id]
    }
    cleanupsRef.current[id] = cleanup
  }

  // refit when switching tabs (the newly shown host was display:none)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const id = activeId
      const fit = id ? fitsRef.current[id] : undefined
      const term = id ? termsRef.current[id] : undefined
      if (id && fit && term) {
        fit.fit()
        void window.api.terminal.resize(id, term.cols, term.rows)
      }
    }, 30)
    return () => window.clearTimeout(t)
  }, [activeId])

  // ------------------------------------------------------------ tab actions
  async function addTerminal(): Promise<void> {
    setStartError(null)
    const res = await window.api.terminal.create()
    if (!res.ok) {
      setStartError(res.error ?? 'failed to start terminal')
      return
    }
    await refresh()
  }

  function closeSession(id: string): void {
    void window.api.terminal.close(id)
    // dispose locally right away (the exit/change events will refresh the tab list)
    cleanupsRef.current[id]?.()
  }

  function selectSession(id: string): void {
    setActiveId(id)
    void window.api.terminal.activate(id)
  }

  const toggleCombo = formatCombo(app.settings?.keybindings?.toggleTerminal ?? defaultKeybindings().toggleTerminal)

  return (
    <>
      <div className="terminal-bar">
        <span className="terminal-label">TERMINAL</span>
        <div className="terminal-tabs">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`term-tab${s.id === activeId ? ' active' : ''}${s.alive ? '' : ' dead'}`}
              onClick={() => selectSession(s.id)}
              title={s.alive ? `${s.title} — running` : `${s.title} — exited`}
            >
              <span className="tt-name">{s.title}</span>
              <span
                className="tt-close"
                role="button"
                title={`Close ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeSession(s.id)
                }}
              >
                ✕
              </span>
            </div>
          ))}
          <button className="tt-add" title="New terminal tab" onClick={() => void addTerminal()}>
            +
          </button>
        </div>
        <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>
          <span className="kbd">{toggleCombo}</span> hide (sessions keep running)
        </span>
        <button style={{ fontSize: 10, padding: '1px 8px' }} onClick={() => app.toggleTerminal()}>
          hide
        </button>
      </div>
      <div className="terminal-bodies">
        {sessions.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              hostRefs.current[s.id] = el
              if (el) initTerm(s.id)
            }}
            className="terminal-host"
            style={{ display: s.id === activeId ? 'block' : 'none' }}
          />
        ))}
        {sessions.length === 0 && (
          <div className="terminal-empty">
            No terminal open — <button style={{ fontSize: 11, padding: '1px 8px' }} onClick={() => void addTerminal()}>+ new terminal</button>
          </div>
        )}
      </div>
      {startError && <div style={{ padding: '4px 10px', color: 'var(--danger)', fontSize: 11 }}>{startError}</div>}
    </>
  )
}