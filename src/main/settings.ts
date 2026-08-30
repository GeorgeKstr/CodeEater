import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { AppSettings, DEFAULT_SETTINGS, DEFAULT_AI_CONFIG, AIConfig } from '../shared/types'

let cache: AppSettings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache
  let result: AppSettings
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    result = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      ai: { ...DEFAULT_AI_CONFIG, ...(parsed.ai ?? {}) }
    }
  } catch {
    result = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }
  cache = result
  return result
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const base = await loadSettings()
  cache = { ...base, ...partial, ai: { ...base.ai, ...(partial.ai ?? {}) } }
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(cache, null, 2), 'utf-8')
  return cache!
}

export async function updateAiConfig(cfg: Partial<AIConfig>): Promise<AppSettings> {
  return saveSettings({ ai: { ...(await loadSettings()).ai, ...cfg } })
}