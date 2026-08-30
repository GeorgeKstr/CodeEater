; (async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  try {
    // create session #1
    const a = await window.api.terminal.create()
    step('terminal-create-1', a.ok, JSON.stringify(a))
    let list = await window.api.terminal.list()
    step('terminal-list-1', list.length === 1, JSON.stringify(list.map((s) => s.id)))

    // second tab
    const b = await window.api.terminal.create()
    step('terminal-create-2', b.ok, JSON.stringify(b))
    list = await window.api.terminal.list()
    step('terminal-list-2', list.length === 2, JSON.stringify(list.map((s) => `${s.id}:${s.alive}`)))

    const idA = a.id
    const idB = b.id

    // route data to the right session
    const packets = []
    const offData = window.api.terminal.onData((id, data) => packets.push({ id, data }))
    await window.api.terminal.activate(idA)
    await window.api.terminal.write(idA, 'echo tab_a\r')
    await window.api.terminal.write(idB, 'echo tab_b\r')
    await new Promise((r) => setTimeout(r, 2500))
    offData()
    const aGot = packets.filter((p) => p.id === idA).map((p) => p.data).join('')
    const bGot = packets.filter((p) => p.id === idB).map((p) => p.data).join('')
    step('terminal-routed-data', aGot.includes('tab_a') && bGot.includes('tab_b'), `a:${aGot.slice(0, 40)} b:${bGot.slice(0, 40)}`)

    // close one tab; the other keeps running
    await window.api.terminal.close(idA)
    list = await window.api.terminal.list()
    step('terminal-close', list.length === 1 && list[0].id === idB, JSON.stringify(list.map((s) => s.id)))

    let got = ''
    const off = window.api.terminal.onData((id, d) => { if (id === idB) got += d })
    await window.api.terminal.write(idB, 'echo tab_b_alive\r')
    await new Promise((r) => setTimeout(r, 2200))
    off()
    step('terminal-survives-close', got.includes('tab_b_alive'), got.slice(0, 60))

    // cleanup
    await window.api.terminal.close(idB)
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()