import React, { useEffect, useState } from 'react'
import { useApp } from '../app/AppContext'
import { DEFAULT_AI_CONFIG, DEFAULT_TERMINAL_SETTINGS, type KeybindingMap } from '../../shared/types'
import { comboFromEvent, defaultKeybindings, formatCombo } from '../../shared/utils'

type CommandId = keyof KeybindingMap

const COMMANDS: { id: CommandId; label: string; hint: string }[] = [
  { id: 'findFile', label: 'Find file', hint: 'Open the fuzzy file finder' },
  { id: 'toggleTerminal', label: 'Toggle terminal', hint: 'Show / hide the terminal pane' },
  { id: 'newTerminal', label: 'New terminal', hint: 'Create a new terminal tab' },
  { id: 'saveFile', label: 'Save file', hint: 'Save the active file' },
  { id: 'closeTab', label: 'Close tab', hint: 'Close the active editor tab' },
  { id: 'openPreferences', label: 'Open preferences', hint: 'Open this panel' }
]

/** Settings panel: AI, hotkeys, terminal — each in its own section. */
export function SettingsPanel(): React.JSX.Element {
  const app = useApp()
  const settings = app.settings

  // AI
  const [baseUrl, setBaseUrl] = useState(settings?.ai.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl)
  const [modelMode, setModelMode] = useState<'auto' | 'manual'>(settings?.ai.modelMode ?? 'auto')
  const [model, setModel] = useState(settings?.ai.model ?? '')
  const [contextWindow, setContextWindow] = useState(String(settings?.ai.contextWindow ?? 32768))

  // hotkeys — local draft, applied on Save
  const [keybindings, setKeybindings] = useState<KeybindingMap>({ ...(settings?.keybindings ?? defaultKeybindings()) })
  const [recording, setRecording] = useState<CommandId | null>(null)

  // terminal
  const [fontSize, setFontSize] = useState(String(settings?.terminal.fontSize ?? DEFAULT_TERMINAL_SETTINGS.fontSize))
  const [fontFamily, setFontFamily] = useState(settings?.terminal.fontFamily ?? DEFAULT_TERMINAL_SETTINGS.fontFamily)
  const [scrollback, setScrollback] = useState(String(settings?.terminal.scrollback ?? DEFAULT_TERMINAL_SETTINGS.scrollback))

  const [saving, setSaving] = useState(false)
  const ai = app.ai

  // capture a new keybinding while recording
  useEffect(() => {
    if (recording === null) return
    const cmd: CommandId = recording
    function onKey(e: KeyboardEvent): void {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt') return
      const combo = comboFromEvent(e)
      setKeybindings((kb) => ({ ...kb, [cmd]: combo }))
      setRecording(null)
    }
    // capture phase: swallow the key so global hotkeys don't fire while recording
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await app.updateAiCfg({
        baseUrl: baseUrl.trim(),
        modelMode,
        model: modelMode === 'manual' ? model.trim() : undefined,
        contextWindow: Math.max(2048, Number(contextWindow) || 32768)
      })
      await app.updateSettings({
        keybindings,
        terminal: {
          fontSize: Math.min(24, Math.max(9, Number(fontSize) || 12)),
          fontFamily: fontFamily.trim(),
          scrollback: Math.max(500, Math.min(100000, Number(scrollback) || 5000))
        }
      })
    } finally {
      setSaving(false)
    }
  }

  function resetHotkeys(): void {
    setKeybindings(defaultKeybindings())
  }

  return (
    <div className="settings-panel">
      <div className="settings-head">
        <h3>Preferences</h3>
        <button style={{ padding: '1px 8px' }} onClick={() => app.setSettingsOpen(false)}>✕</button>
      </div>

      {/* ------------------------------------------------ hotkeys */}
      <div className="settings-section">
        <div className="settings-section-title">Hotkeys</div>
        <div className="hotkey-list">
          {COMMANDS.map((c) => (
            <KeyRecorderRow
              key={c.id}
              command={c}
              combo={keybindings[c.id]}
              recording={recording === c.id}
              onBegin={() => setRecording(c.id)}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <button style={{ fontSize: 11, padding: '1px 8px' }} onClick={resetHotkeys}>
            Reset defaults
          </button>
          {recording ? (
            <span style={{ fontSize: 11, color: 'var(--warning)' }}>press keys… (Esc to cancel)</span>
          ) : (
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Click a key to record a new shortcut</span>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ terminal */}
      <div className="settings-section">
        <div className="settings-section-title">Terminal</div>
        <div className="settings-row">
          <label>Font size</label>
          <input value={fontSize} onChange={(e) => setFontSize(e.target.value)} type="number" min={9} max={24} step={1} />
        </div>
        <div className="settings-row">
          <label>Font family</label>
          <input value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} spellCheck={false} placeholder="monospace" />
        </div>
        <div className="settings-row">
          <label>Scrollback (lines)</label>
          <input value={scrollback} onChange={(e) => setScrollback(e.target.value)} type="number" min={500} step={500} />
        </div>
      </div>

      {/* ------------------------------------------------ AI */}
      <div className="settings-section">
        <div className="settings-section-title">AI</div>
        <div className="settings-row">
          <label>AI Endpoint (OpenAI-compatible)</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:1234/v1" spellCheck={false} />
        </div>

        <div className="settings-row">
          <label>Model Mode</label>
          <select value={modelMode} onChange={(e) => setModelMode(e.target.value as 'auto' | 'manual')}>
            <option value="auto">Auto (use available model)</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        {modelMode === 'manual' && (
          <div className="settings-row">
            <label>Model</label>
            <input
              value={model}
              list="model-list"
              onChange={(e) => setModel(e.target.value)}
              placeholder="model id"
              spellCheck={false}
            />
            <datalist id="model-list">
              {ai.models.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>
        )}

        <div className="settings-row">
          <label>Context Window (tokens)</label>
          <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} type="number" min={4096} step={1024} />
        </div>

        <div className="settings-status">
          <span className="status-dot" style={{ background: statusColor(ai.status) }} />
          <span>
            {statusLabel(ai.status)}
            {ai.activeModel ? ` · ${ai.activeModel}` : ''}
          </span>
        </div>
        {ai.error && <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 8 }}>{ai.error}</div>}
      </div>

      <div className="settings-actions">
        <button disabled={saving} onClick={() => void app.connectAi().then(() => setSaving(false))}>
          Test connection
        </button>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Hotkeys apply immediately after saving. Terminal prefs apply to new tabs.
        AI is advisory only — edits always become reviewable Change Requests.
      </div>
    </div>
  )
}

function KeyRecorderRow(props: {
  command: { id: CommandId; label: string; hint: string }
  combo: string
  recording: boolean
  onBegin(): void
}): React.JSX.Element {
  const { command, combo, recording, onBegin } = props
  return (
    <div className="hotkey-row">
      <div className="hk-info">
        <span className="hk-label">{command.label}</span>
        <span className="hk-hint">{command.hint}</span>
      </div>
      {recording ? (
        <span className="hk-recording">press keys…</span>
      ) : (
        <button className="hk-recorder" onClick={onBegin}>
          {formatCombo(combo) || '—'}
        </button>
      )}
    </div>
  )
}

function statusColor(s: string): string {
  switch (s) {
    case 'connected': return 'var(--accent-2)'
    case 'connecting': return 'var(--warning)'
    case 'offline':
    case 'error': return 'var(--danger)'
    default: return 'var(--text-faint)'
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'offline': return 'Offline'
    case 'error': return 'Error'
    default: return 'Not configured / unconfigured'
  }
}