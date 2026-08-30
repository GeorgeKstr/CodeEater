import React, { useEffect, useState } from 'react'
import { useApp } from '../app/AppContext'
import { ProjectFeature, FeatureFile, SessionSummary, RunCommand } from '../../shared/types'
import { formatRelativeTime } from '../../shared/utils'

/**
 * Right pane: PROJECT | FILE overview tabs.
 * Navigation over prose: short labels, jump links, related files.
 */

export function OverviewPane(): React.JSX.Element {
  const [tab, setTab] = useState<'project' | 'file'>('project')

  // when a file becomes active, follow the FILE tab briefly? No — keep user's tab.
  return (
    <div className="overview-pane">
      <div className="ov-tabs">
        <button className={`ov-tab${tab === 'project' ? ' active' : ''}`} onClick={() => setTab('project')}>
          PROJECT
        </button>
        <button className={`ov-tab${tab === 'file' ? ' active' : ''}`} onClick={() => setTab('file')}>
          FILE
        </button>
      </div>
      {tab === 'project' ? <ProjectOverviewBody /> : <FileOverviewBody />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PROJECT tab
// ---------------------------------------------------------------------------

function ProjectOverviewBody(): React.JSX.Element {
  const app = useApp()
  const ov = app.projectOverview

  useEffect(() => {
    if (app.projectRoot && !ov) void app.refreshProjectOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.projectRoot])

  if (!ov) {
    return (
      <div className="ov-scroll">
        <div className="ov-loading">
          <span className="spinner" /> Building project overview…
        </div>
      </div>
    )
  }

  return (
    <div className="ov-scroll">
      <OvSection title="PROJECT SUMMARY" right={<button className="refresh" onClick={() => void app.refreshProjectOverview(true)}>refresh</button>}>
        <p className="ov-summary">{ov.summary}</p>
        {ov.cached && <div className="ov-cached">cached · {formatRelativeTime(ov.generatedAt)}</div>}
      </OvSection>

      <OvSection title="RUNNING">
        {ov.commands.length === 0 ? (
          <div className="ov-cached">No commands discovered.</div>
        ) : (
          ov.commands.map((c, i) => <CommandRow key={i} c={c} />)
        )}
      </OvSection>

      <OvSection title="FEATURES">
        {ov.features.map((f) => (
          <FeatureItem key={f.name} feature={f} />
        ))}
        {ov.features.length === 0 && <div className="ov-cached">No features detected yet.</div>}
      </OvSection>

      <OvSection title="RECENT WORK">
        {ov.recentWork.length === 0 ? (
          <div className="ov-cached">No sessions yet.</div>
        ) : (
          ov.recentWork.map((s, i) => <WorkItem key={i} s={s} />)
        )}
      </OvSection>
    </div>
  )
}

function CommandRow({ c }: { c: RunCommand }): React.JSX.Element {
  const app = useApp()
  return (
    <div className="command-row">
      <span style={{ width: 70, color: 'var(--text-faint)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {c.label}
      </span>
      <button onClick={() => app.toggleTerminal()}>▶</button>
      <span>{c.command}</span>
      <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>· {c.source}</span>
    </div>
  )
}

function FeatureItem({ feature }: { feature: ProjectFeature }): React.JSX.Element {
  const app = useApp()
  const [open, setOpen] = useState(feature.resolved === true || feature.files !== undefined)
  const [loading, setLoading] = useState(false)

  async function toggle(): Promise<void> {
    if (!open && !feature.files) {
      setLoading(true)
      await app.resolveFeature(feature.name, feature.searchHints)
      setLoading(false)
    }
    setOpen(!open)
  }

  return (
    <div className="feature-item">
      <div className="feature-head" onClick={() => void toggle()}>
        <span className="arrow">{open ? '▾' : '▸'}</span>
        <span>{feature.name}</span>
        {loading && <span className="spinner" style={{ width: 10, height: 10 }} />}
      </div>
      {open && (
        <div className="feature-body">
          {feature.summary && <div className="feature-summary">{feature.summary}</div>}
          {!feature.files || feature.files.length === 0 ? (
            <div className="ov-cached">No files mapped yet.{feature.searchHints.length ? ` hints: ${feature.searchHints.join(', ')}` : ''}</div>
          ) : (
            feature.files.map((f) => <FeatureFileRow key={f.path} f={f} />)
          )}
        </div>
      )}
    </div>
  )
}

function FeatureFileRow({ f }: { f: FeatureFile }): React.JSX.Element {
  const app = useApp()
  return (
    <div>
      <div
        className="feature-file"
        onClick={() => {
          void app.openFile(f.path)
          if (f.locations[0]) {
            app.requestReveal(f.path, f.locations[0].startLine, f.locations[0].endLine)
          }
        }}
      >
        <span className="imp">{f.importance}</span>
        <span className="fpath">{f.path}</span>
      </div>
      {f.locations.length > 0 && (
        <div style={{ paddingLeft: 62 }}>
          {f.locations.map((loc, i) => (
            <div
              key={i}
              className="feature-file"
              style={{ paddingLeft: 0, fontSize: 11 }}
              onClick={() => {
                void app.openFile(f.path)
                app.requestReveal(f.path, loc.startLine, loc.endLine)
              }}
            >
              <span className="floc">{loc.startLine}–{loc.endLine}</span>
              <span className="reason">{loc.label}</span>
            </div>
          ))}
        </div>
      )}
      {f.reason && <div className="reason" style={{ paddingLeft: 62, paddingBottom: 4 }}>{f.reason}</div>}
    </div>
  )
}

function WorkItem({ s }: { s: SessionSummary }): React.JSX.Element {
  const app = useApp()
  return (
    <div
      className="work-item"
      title={s.summary}
      onClick={() => {
        // clicking a session opens its files
        if (s.files[0]) void app.openFile(s.files[0])
      }}
    >
      <div className="title">{s.title}</div>
      <div className="sub">{s.summary}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FILE tab
// ---------------------------------------------------------------------------

function FileOverviewBody(): React.JSX.Element {
  const app = useApp()
  const ov = app.fileOverview

  useEffect(() => {
    if (app.activePath) void app.refreshFileOverview()
    else setFileOverviewNull(app)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.activePath])

  if (!app.activePath) {
    return (
      <div className="ov-scroll">
        <div className="ov-cached">Open a file to see its overview.</div>
      </div>
    )
  }

  if (!ov) {
    return (
      <div className="ov-scroll">
        <div className="ov-loading">
          <span className="spinner" /> Analyzing file…
        </div>
      </div>
    )
  }

  return (
    <div className="ov-scroll">
      <OvSection title="FILE SUMMARY" right={<button className="refresh" onClick={() => void app.refreshFileOverview(true)}>refresh</button>}>
        <p className="ov-summary">{ov.summary}</p>
        {ov.cached && <div className="ov-cached">cached · {formatRelativeTime(ov.generatedAt)}</div>}
      </OvSection>

      <OvSection title="CONTENTS">
        {ov.sections.map((s, i) => (
          <div
            key={i}
            className="section-item"
            onClick={() => {
              void app.openFile(ov.path)
              app.requestReveal(ov.path, s.startLine, s.endLine)
            }}
          >
            <span>{s.title}</span>
            <span className="lines">{s.startLine}–{s.endLine}</span>
          </div>
        ))}
        {ov.sections.length === 0 && <div className="ov-cached">No sections identified.</div>}
      </OvSection>

      <OvSection title="RELATED FILES">
        {ov.relatedFiles.map((r, i) => (
          <div
            key={i}
            className="rel-file"
            onClick={() => void app.openFile(r.path)}
            title={r.reason}
          >
            <span className="badge">{r.relationshipType === 'direct' ? 'direct' : 'rel'}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.path}</span>
          </div>
        ))}
        {ov.relatedFiles.length === 0 && <div className="ov-cached">None found.</div>}
      </OvSection>
    </div>
  )
}

function setFileOverviewNull(app: ReturnType<typeof useApp>): void {
  void app
}

function OvSection({
  title,
  children,
  right
}: {
  title: string
  children: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ov-section">
      <h3>
        {title}
        {right}
      </h3>
      {children}
    </div>
  )
}