;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  try {
    const started = await window.api.terminal.start()
    step('terminal-start', started.ok, JSON.stringify(started))
    await new Promise((r) => setTimeout(r, 800))
    const running = await window.api.terminal.isRunning()
    step('terminal-running', running)
    let got = ''
    const off = window.api.terminal.onData((d) => {
      got += d
    })
    await window.api.terminal.write('echo term_smoke_ok\r')
    await new Promise((r) => setTimeout(r, 2500))
    off()
    step('terminal-data', got.includes('term_smoke_ok'), got.slice(0, 100))
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()