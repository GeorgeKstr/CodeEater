import { app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerIpc, setMainWindow, shutdown, initProject } from './ipc/register'
import { connectAI } from './ai/service'
import { closeProject } from './project'

const __dirname = import.meta.dirname

// Keep windows from being garbage collected.
let mainWindow: BrowserWindow | null = null

/** Absolute path to the app icon (repo build/ directory). */
function appIconPath(): string {
  for (const candidate of [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../../build/icon.png')
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

/** Canonicalize a CLI positional argument into a project root, or null. */
async function cliProjectArg(): Promise<string | null> {
  const args = process.argv.slice(2)
  for (const a of args) {
    if (a.startsWith('-')) continue
    try {
      const abs = path.resolve(a)
      const st = await fs.promises.stat(abs)
      if (st.isDirectory()) return abs
    } catch {
      /* not a directory — skip */
    }
  }
  return null
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#1e1f25',
    icon: appIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.env.CODEEATER_DEBUG) {
    const logPath = path.join(app.getPath('userData'), 'renderer-console.log')
    const { appendFileSync } = require('fs') as typeof import('fs')
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      try {
        appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${sourceId}:${line} ${message}\n`)
      } catch {
        /* ignore */
      }
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      try {
        appendFileSync(logPath, `[${new Date().toISOString()}] did-fail-load ${code} ${desc}\n`)
      } catch {
        /* ignore */
      }
    })
    mainWindow.webContents.on('did-finish-load', () => {
      try {
        appendFileSync(logPath, `[${new Date().toISOString()}] did-finish-load\n`)
      } catch {
        /* ignore */
      }
      if (process.env.CODEEATER_SMOKE) {
        const driverPath = process.env.CODEEATER_SMOKE
        const fsSync2 = require('fs') as typeof import('fs')
        setTimeout(() => {
          const code = fsSync2.readFileSync(driverPath, 'utf-8')
          void mainWindow?.webContents
            .executeJavaScript(code, true)
            .then((result: unknown) => {
              fsSync2.writeFileSync(
                path.join(app.getPath('userData'), 'smoke-result.json'),
                JSON.stringify(result, null, 2)
              )
              console.log('SMOKE_RESULT_READY')
              app.exit(0)
            })
            .catch((e: Error) => {
              fsSync2.writeFileSync(
                path.join(app.getPath('userData'), 'smoke-result.json'),
                JSON.stringify({ fatal: e.message })
              )
              console.log('SMOKE_FATAL', e.message)
              app.exit(1)
            })
        }, 2500)
      } else {
        setTimeout(() => {
          void mainWindow?.webContents
            .capturePage()
            .then((img) => {
              const fs = require('fs') as typeof import('fs')
              fs.writeFileSync(path.join(app.getPath('userData'), 'debug-shot.png'), img.toPNG())
            })
            .catch(() => undefined)
        }, 6000)
      }
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerIpc()
  void connectAI() // keep AI status live even before a project is opened
  await createWindow()
  setMainWindow(mainWindow!)

  // CLI: `coe <dir>` opens that directory as a project.
  const projectRoot = await cliProjectArg()
  if (projectRoot) {
    void initProject(projectRoot).catch((e) => console.error('failed to open project from CLI:', e))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  // stop watcher + sessions + terminal cleanly
  try {
    e.preventDefault()
    await shutdown()
    await closeProject()
    app.exit(0)
  } catch {
    app.exit(0)
  }
})