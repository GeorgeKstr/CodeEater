;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }) }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    // CLI-opened project should already be set in main
    let state = await window.api.project.getState()
    for (let i = 0; i < 10 && !state; i++) { await sleep(500); state = await window.api.project.getState() }
    step('main-project-open', !!state, state ? `${state.root} tabs=${state.openTabs.length}` : 'none')
    const tree = await window.api.project.getTree()
    step('tree', tree.length > 0, tree.map((n) => n.name).join(','))
    // open a file (as the UI would on activation)
    await window.api.fs.readFile('src/services/SearchService.ts')
    step('read-file', true)
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()