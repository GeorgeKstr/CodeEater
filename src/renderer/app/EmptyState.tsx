import { useApp } from './AppContext'

export function EmptyState(): React.JSX.Element {
  const app = useApp()
  return (
    <div className="empty-state">
      <h2>CodeEater</h2>
      <div className="big">Open a project to get started.</div>
      <button className="primary" onClick={() => void app.openProjectDialog()}>
        Open Project…
      </button>
      {app.settings?.recentProjects.length ? (
        <div style={{ width: 320 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>RECENT</div>
          <div className="recents-list">
            {app.settings.recentProjects.slice(0, 6).map((r) => (
              <div key={r.path} className="recent-item" onClick={() => void app.openProjectByPath(r.path)}>
                <span className="name">{r.name}</span>
                <span className="path">{r.path}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
        <span className="kbd">Ctrl+P</span> files · <span className="kbd">Ctrl+`</span> terminal ·{' '}
        <span className="kbd">Ctrl+S</span> save
      </div>
    </div>
  )
}