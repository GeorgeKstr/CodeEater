; (async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const key = (opts) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts }))
  const has = (sel) => !!document.querySelector(sel)
  try {
    await window.api.project.open('/tmp/ce-demo')
    await sleep(5000)

    // normalize: ensure the terminal pane starts hidden
    if (has('.terminal-bar')) {
      key({ key: '`', ctrlKey: true })
      await sleep(300)
    }

    // negative: an unbound combo must NOT toggle the terminal
    key({ key: 't', altKey: true })
    await sleep(300)
    step('unbound-combo-ignored', !has('.terminal-bar'))

    // default binding toggles the pane
    key({ key: '`', ctrlKey: true })
    await sleep(400)
    step('hotkey-toggle-terminal', has('.terminal-bar'), 'pane visible')

    // ensure a session exists, then verify a tab + close btn + + button
    await window.api.terminal.create()
    await sleep(400)
    step('terminal-tabs-row', has('.term-tab') && has('.term-tab .tt-close') && has('.terminal-tabs .tt-add'),
      `tabs=${document.querySelectorAll('.term-tab').length}`)

    // second tab appears
    await window.api.terminal.create()
    await sleep(400)
    const tabCount = document.querySelectorAll('.term-tab').length
    step('terminal-two-tabs', tabCount === 2, `tabs=${tabCount}`)

    // clicking a tab activates it (active class moves)
    const tabs = document.querySelectorAll('.term-tab')
    const first = tabs[0]
    const second = tabs[1]
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(200)
    step('terminal-tab-activate', first.classList.contains('active') && !second.classList.contains('active'))

    // close button on first tab removes it
    first.querySelector('.tt-close').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(500)
    step('terminal-tab-close', document.querySelectorAll('.term-tab').length === 1, `tabs=${document.querySelectorAll('.term-tab').length}`)

    // preferences via default binding (ctrl+,)
    key({ key: ',', ctrlKey: true })
    await sleep(400)
    step('hotkey-open-preferences', has('.settings-panel'), 'panel visible')
    step('preferences-sections',
      document.querySelectorAll('.settings-section').length >= 3 &&
      (() => { const t = document.querySelector('.settings-panel').textContent; return t.includes('Hotkeys') && t.includes('Terminal') && t.includes('AI') })())
    const hotkeyRows = document.querySelectorAll('.hotkey-row').length
    step('preferences-hotkey-rows', hotkeyRows === 6, `rows=${hotkeyRows}`)

    // full rebind via the UI: Find file → ctrl+shift+p, then Save
    const firstRecorder = document.querySelector('.hk-recorder')
    firstRecorder.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(200)
    key({ key: 'p', ctrlKey: true, shiftKey: true })
    await sleep(400)
    step('hotkey-recorded', firstRecorder.textContent.includes('Ctrl') || firstRecorder.textContent.includes('⇧'), firstRecorder.textContent)
    const saveBtn = document.querySelector('.settings-actions button.primary')
    saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(900)
    // close the panel
    document.querySelector('.settings-head button').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)

    // new binding opens the finder, old one no longer does
    key({ key: 'p', ctrlKey: true, shiftKey: true })
    await sleep(400)
    step('rebound-hotkey-works', has('.fuzzy-box'), 'fuzzy finder open')
    const closeFinder = () => {
      const inp = document.querySelector('.fuzzy-box input')
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    }
    closeFinder()
    await sleep(200)
    key({ key: 'p', ctrlKey: true })
    await sleep(400)
    step('old-hotkey-disabled', !has('.fuzzy-box'), 'ctrl+p no longer opens finder')

    // restore defaults through the UI too
    key({ key: ',', ctrlKey: true })
    await sleep(400)
    const recorder = document.querySelector('.hk-recorder')
    recorder.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(200)
    key({ key: 'p', ctrlKey: true })
    await sleep(400)
    document.querySelector('.settings-actions button.primary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(900)
    document.querySelector('.settings-head button').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)
    key({ key: 'p', ctrlKey: true })
    await sleep(400)
    step('hotkeys-restored', has('.fuzzy-box'), 'ctrl+p works again')
    const inp = document.querySelector('.fuzzy-box input')
    if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    // leave the terminal hidden for repeatable runs
    if (has('.terminal-bar')) {
      key({ key: '`', ctrlKey: true })
      await sleep(300)
    }
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()