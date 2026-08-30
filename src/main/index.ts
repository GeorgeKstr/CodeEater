import { app, BrowserWindow } from 'electron'
import path from 'path'
import { registerIpc, setMainWindow, shutdown } from './ipc/register'
import { closeProject } from './project'

const __dirname = import.meta.dirname

// Keep windows from being garbage collected.
let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#1e1f25',
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
  await createWindow()
  setMainWindow(mainWindow!)
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