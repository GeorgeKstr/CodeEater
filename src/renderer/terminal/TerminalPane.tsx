import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useApp } from '../app/AppContext'

/**
 * Bottom terminal pane: xterm.js here, node-pty in main.
 * Hiding the pane does not kill the process — the session keeps running.
 */
export function TerminalPane(): React.JSX.Element {
  const app = useApp()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [started, setStarted] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "var(--mono)",
      theme: { background: '#141519', foreground: '#d7dae0', cursor: '#d7dae0' },
      scrollback: 5000,
      convertEol: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const offData = window.api.terminal.onData((data) => term.write(data))
    const offExit = window.api.terminal.onExit(() => setStarted(false))
    const onKeySub = term.onData((data) => void window.api.terminal.write(data))

    const doResize = (): void => {
      fit.fit()
      void window.api.terminal.resize(term.cols, term.rows)
    }
    doResize()
    const observer = new ResizeObserver(() => doResize())
    observer.observe(hostRef.current)

    void window.api.terminal.isRunning().then((r) => {
      if (!r) {
        void window.api.terminal.start().then((res) => {
          if (res.ok) {
            setStarted(true)
            term.reset()
          } else {
            setStartError(res.error ?? 'failed to start terminal')
          }
        })
      } else {
        setStarted(true)
      }
    })

    return () => {
      onKeySub.dispose()
      offData()
      offExit()
      observer.disconnect()
      term.dispose()
    }
  }, [])

  return (
    <>
      <div className="terminal-bar">
        <span>TERMINAL</span>
        <span style={{ color: 'var(--text-faint)' }}>{started ? '● running' : 'starting…'}</span>
        <span style={{ marginLeft: 'auto' }}>
          <span className="kbd">Ctrl+`</span> hide (session keeps running)
        </span>
        {app.terminalVisible && (
          <button style={{ fontSize: 10, padding: '1px 8px' }} onClick={() => app.toggleTerminal()}>
            hide
          </button>
        )}
      </div>
      <div ref={hostRef} className="terminal-host" />
      {startError && <div style={{ padding: '4px 10px', color: 'var(--danger)', fontSize: 11 }}>{startError}</div>}
    </>
  )
}

void useState