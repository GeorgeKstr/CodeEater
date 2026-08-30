;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    await window.api.project.open('/tmp/ce-demo')
    await sleep(3000)
    let ai = await window.api.ai.getState()
    for (let i = 0; i < 30 && ai.status !== 'connected'; i++) { await sleep(500); ai = await window.api.ai.getState() }
    step('ai-connected', ai.status === 'connected', ai.activeModel ?? '')
    const expanded = await window.api.ai.run('ai-search-expand', { query: 'password reset' })
    step('expand', true, JSON.stringify(expanded))
    const retr = await window.api.search.text({ query: 'password', maxResults: 20 })
    const retr2 = await window.api.search.text({ query: 'reset', maxResults: 20 })
    step('rg-password', retr.length > 0, retr.map((r) => r.relPath).join(','))
    step('rg-reset', retr2.length > 0, retr2.map((r) => r.relPath).join(','))
    const syms = await window.api.search.getSymbols('src/services/UserService.ts')
    step('has-resetSymbol', syms.some((s) => s.name.includes('reset')), syms.map((s) => s.name).join(','))
    const final = await window.api.ai.run('ai-search-final', { query: 'password reset', expanded })
    step('final', final.results.length > 0, `summary=${final.summary} results=${final.results.map((r) => `${r.path}(${r.startLine})`).join(',')}`)
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()