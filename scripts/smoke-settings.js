; (async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  try {
    // defaults are platform-aware and complete
    const s0 = await window.api.settings.get()
    const kb0 = s0.keybindings
    step('settings-keybindings', !!(kb0.findFile && kb0.toggleTerminal && kb0.saveFile && kb0.newTerminal),
      JSON.stringify(kb0))

    // rebind and persist
    const merged = { ...kb0, toggleTerminal: 'alt+t', findFile: 'ctrl+shift+f' }
    const s1 = await window.api.settings.update({ keybindings: merged })
    step('settings-rebind', s1.keybindings.toggleTerminal === 'alt+t' && s1.keybindings.findFile === 'ctrl+shift+f',
      JSON.stringify(s1.keybindings))

    // nested terminal prefs are preserved through updates
    step('settings-terminal-nested', s1.terminal.fontSize === 12 && s1.terminal.scrollback === 5000, JSON.stringify(s1.terminal))
    const s2 = await window.api.settings.update({ terminal: { fontSize: 14, fontFamily: 'Fira Code', scrollback: 8000 } })
    step('settings-terminal-set', s2.terminal.fontSize === 14 && s2.terminal.scrollback === 8000, JSON.stringify(s2.terminal))

    // restore defaults for the developer machine
    const restored = { ...s2.keybindings, toggleTerminal: kb0.toggleTerminal, findFile: kb0.findFile }
    await window.api.settings.update({ keybindings: restored, terminal: s0.terminal })
    const s3 = await window.api.settings.get()
    step('settings-restore', s3.keybindings.toggleTerminal === kb0.toggleTerminal, JSON.stringify(s3.keybindings))
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()