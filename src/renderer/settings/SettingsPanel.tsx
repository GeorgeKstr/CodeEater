import React, { useState } from 'react'
import { useApp } from '../app/AppContext'
import { DEFAULT_AI_CONFIG } from '../../shared/types'

/** Settings panel: AI endpoint, model mode, model, context window, status. */
export function SettingsPanel(): React.JSX.Element {
  const app = useApp()
  const settings = app.settings
  const [baseUrl, setBaseUrl] = useState(settings?.ai.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl)
  const [modelMode, setModelMode] = useState<'auto' | 'manual'>(settings?.ai.modelMode ?? 'auto')
  const [model, setModel] = useState(settings?.ai.model ?? '')
  const [contextWindow, setContextWindow] = useState(String(settings?.ai.contextWindow ?? 32768))
  const [saving, setSaving] = useState(false)

  const ai = app.ai

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await app.updateAiCfg({
        baseUrl: baseUrl.trim(),
        modelMode,
        model: modelMode === 'manual' ? model.trim() : undefined,
        contextWindow: Math.max(2048, Number(contextWindow) || 32768)
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Settings</h3>
        <button style={{ padding: '1px 8px' }} onClick={() => app.setSettingsOpen(false)}>✕</button>
      </div>

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

      <div className="settings-actions">
        <button disabled={saving} onClick={() => void app.connectAi().then(() => setSaving(false))}>
          Test connection
        </button>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save & connect'}
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Target: LM Studio / llama.cpp server (localhost). The editor uses whichever model is loaded.
        AI is advisory only — edits always become reviewable Change Requests.
      </div>
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