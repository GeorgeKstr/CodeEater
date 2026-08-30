;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    await window.api.project.open('/tmp/ce-demo')
    await sleep(6000)
    // open files like a user would (tabs)
    await window.api.fs.readFile('src/services/UserService.ts')
    await window.api.fs.readFile('src/services/SearchService.ts')
    // deterministic search
    const hits = await window.api.search.text({ query: 'rank', maxResults: 10 })
    step('search-rank', hits.length > 0, hits.map((h) => h.relPath + ':' + h.line).join(','))
    // fetch file + project overviews for the UI
    await window.api.overview.getFileOverview('src/services/SearchService.ts')
    const po = await window.api.overview.getProjectOverview()
    step('po', po.summary.length > 5, po.summary)
    // feature resolution
    const resolved = await window.api.overview.resolveFeature('Authentication', ['auth', 'user', 'login'])
    step('feature-resolved', (resolved.files?.length ?? 0) > 0, JSON.stringify((resolved.files ?? []).map((f) => f.path)))
    // sessions
    const sessions = await window.api.sessions.list(5)
    step('sessions', sessions.length > 0, `${sessions.length} sessions`)
    // keep window alive briefly for the screenshot, then finish
    await sleep(8000)
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()