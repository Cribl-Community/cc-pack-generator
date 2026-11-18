// Goatpedia library screen (home tile and rail entry "Goatpedia library").
// Browse is the app's page header over the Goatpedia site's cards; an article is
// the site's article page, ported from SE Toolkit's Goatpedia page. The one
// addition is "Build a pack" in the article's tab bar, which starts the normal
// Build pack flow at its first step (worker group).
//
// The library is read live from GitHub Pages (src/goatpedia.ts), so the content
// follows the goatpedia repository. Only what is needed is loaded: the browse index
// (cards and search fields), one page of cards at a time, and an article's full
// text only when it is opened. Navigation stays in component state: the app has no
// router, and leaving the screen through the rail or Home resets it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PAGE_SIZE, SITE_URL, categoryOf, cveIds, decorate, diagramSvg, loadEntry, loadLibrary, logoUrl, pageButtons, pageOf, search,
  type DecoratedField, type Entry, type Library, type LogSample, type Optimization,
} from './goatpedia';
import { FUNCTION_NAMES, copyTexts, describe, kb, logOf, measuredPct, pipelineFor } from './goatpedia-stream';
import { SEP } from './goatpedia-parse';
import './goatpedia.css';

type Tab = 'overview' | 'network' | 'logs' | 'cves' | 'detect' | 'optimize';
type View = { kind: 'browse' } | { kind: 'article'; id: string; tab: Tab; log: number };

/** Full articles fetched so far, for this session. */
const FULL = new Map<string, Entry>();

/** The full article: fetched from e/<id>.json once, unless the library already holds it. */
function useFullEntry(lib: Library, id: string): { entry: Entry | null; error: string | null } {
  const known = lib.complete ? lib.entries.find((x) => x.id === id) ?? null : FULL.get(id) ?? null;
  const [loaded, setLoaded] = useState<{ id: string; entry: Entry | null; error: string | null } | null>(null);
  useEffect(() => {
    if (known) return;
    let gone = false;
    loadEntry(id)
      .then((e) => { FULL.set(id, e); if (!gone) setLoaded({ id, entry: e, error: null }); })
      .catch((err: unknown) => { if (!gone) setLoaded({ id, entry: null, error: err instanceof Error ? err.message : 'The article could not be loaded' }); });
    return () => { gone = true; };
  }, [id, known]);
  if (known) return { entry: known, error: null };
  return loaded?.id === id ? loaded : { entry: null, error: null };
}

/** The vendor's logo, or nothing while it loads or when there is none (the category icon stays). */
function Logo({ entry, className }: { entry: Entry; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    if (entry.logo) void logoUrl(entry.logo.src).then((u) => { if (!gone) setUrl(u); });
    return () => { gone = true; };
  }, [entry.logo]);
  if (!entry.logo || !url) return null;
  return <img className={className} src={url} alt={`${entry.logo.title} logo`} title={entry.logo.title} width={28} height={28} />;
}

/** Previous, numbered pages and Next. Nothing when everything fits on one page. */
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="gp-pager" aria-label="Pages">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Previous</button>
      {pageButtons(page, pages).map((x, i) => x == null
        ? <span className="gap" key={`gap${i}`}>…</span>
        : <button type="button" key={x} className={x === page ? 'on' : ''} aria-current={x === page ? 'page' : undefined} onClick={() => onPage(x)}>{x}</button>)}
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
    </nav>
  );
}

const TABS: [Tab, string, 'cves' | 'detections' | null][] = [
  ['overview', 'Overview', null],
  ['network', 'Network & traffic', null],
  ['logs', 'Logs', null],
  ['cves', 'Vulnerabilities', 'cves'],
  ['detect', 'Detect', 'detections'],
  ['optimize', 'Optimize', null],
];

const cvssColor = (v: number) => (v >= 9 ? '#c92a2a' : v >= 7 ? '#e8590c' : v >= 4 ? '#f08c00' : '#2f9e44');
const sevColor = (s: string) => ({ critical: '#c92a2a', high: '#e8590c', medium: '#f08c00', low: '#2f9e44' }[s] || '#868e96');
const mitreUrl = (t: string) => `https://attack.mitre.org/techniques/${t.replace('.', '/')}/`;

/** An in-screen link: an anchor (so the site's `a` styles apply) without an href. */
function Go({ to, className, children }: { to: () => void; className?: string; children: ReactNode }) {
  return (
    <a data-go="" role="link" tabIndex={0} className={className}
      onClick={(ev) => { ev.preventDefault(); to(); }}
      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); to(); } }}>
      {children}
    </a>
  );
}

function Mark({ text, q }: { text: string; q: string }) {
  const src = String(text ?? '');
  const toks = String(q || '').split(/\s+/).filter((t) => t.length > 1);
  if (!toks.length) return <>{src}</>;
  const re = new RegExp(`(${toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(src.slice(last, at));
    out.push(<mark key={at}>{m[0]}</mark>);
    last = at + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return <>{out}</>;
}

function Browse({ lib, q, cat, page, onQuery, onCat, onPage, onOpen }: {
  lib: Library; q: string; cat: string | null; page: number;
  onQuery: (q: string) => void; onCat: (c: string | null) => void; onPage: (p: number) => void; onOpen: (id: string) => void;
}) {
  const { entries, categories } = lib;
  const hits = search(entries, categories, q).filter((x) => !cat || x.e.category === cat);
  // Only one page of cards is drawn.
  const shown = pageOf(hits, page, PAGE_SIZE);
  return (
    <div className="gp-browse">
      <h2>Goatpedia library</h2>
      <p className="gp-desc">How each device works, the logs it produces, sample events, CVEs, detections and optimizations. Read live from the Goatpedia library, so it is always current.</p>
      <label className="gp-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input id="gp-q" value={q} placeholder="Search devices, vendors, sourcetypes, CVEs…" aria-label="Search the library" onChange={(ev) => onQuery(ev.target.value)} />
      </label>
      <div className="gp-filters">
        <button type="button" className={`gp-f${cat ? '' : ' on'}`} onClick={() => onCat(null)}>All</button>
        {Object.entries(categories).map(([k, c]) => (
          <button type="button" key={k} className={`gp-f${cat === k ? ' on' : ''}`} onClick={() => onCat(cat === k ? null : k)}>{c.icon} {c.label}</button>
        ))}
      </div>
      <p className="gp-hint">Open a source to read it and build its pack.</p>
      <div className="grid">
        {shown.items.length ? shown.items.map(({ e }) => {
          const c = categoryOf(categories, e.category);
          const cv = cveIds(e);
          return (
            <Go className={`card${e.logo ? ' has-logo' : ''}`} key={e.id} to={() => onOpen(e.id)}>
              <Logo entry={e} className="card-logo" />
              <div className="cat" style={{ color: c.color }}>{c.icon} {c.label}</div>
              <h3><Mark text={e.name} q={q} /></h3>
              <div className="v"><Mark text={e.vendor} q={q} /></div>
              <p><Mark text={e.summary} q={q} /></p>
              <div>{e.sourcetypes.slice(0, 3).map((s) => <span className="st" key={s.st}><Mark text={s.st} q={q} /></span>)}</div>
              <div className="badges">
                {cv.length ? <span className="b" style={{ background: '#fee2e2', color: '#b91c1c' }}>{cv.length} CVE{cv.length > 1 ? 's' : ''}</span> : null}
                {e.status === 'full'
                  ? <span className="b" style={{ background: '#dcfce7', color: '#166534' }}>full article</span>
                  : <span className="b" style={{ background: '#fef3c7', color: '#92400e' }}>stub</span>}
              </div>
            </Go>
          );
        }) : <div className="empty">Nothing matches that search.</div>}
      </div>
      <Pager page={shown.page} pages={shown.pages} onPage={onPage} />
    </div>
  );
}

/** Copy to the clipboard; the Cribl iframe can refuse, so the button says when it did not work. */
function CopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  const [shown, setShown] = useState(label);
  return (
    <button type="button" className={className} onClick={() => {
      navigator.clipboard?.writeText(text).then(() => setShown('Copied'), () => setShown('Copy failed: use Show JSON'));
      setTimeout(() => setShown(label), 1600);
    }}>{shown}</button>
  );
}

/** "In Cribl Stream": the exact functions for this optimization, as on the Goatpedia site. */
function StreamBlockView({ e, o }: { e: Entry; o: Optimization }) {
  const st = o.stream!;
  const pipe = pipelineFor(e, o);
  const log = logOf(e, st);
  const copy = pipe ? copyTexts(pipe) : null;
  const v = o.verified;
  return (
    <div className="sx"><div className="sx-h">In Cribl Stream</div>
      {st.note ? <p className="sx-note">{st.note}</p> : null}
      {pipe && copy && log ? (
        <>
          {v?.ok
            ? <div className="sx-ok">✓ Checked in Cribl Stream on {v.checked}: {v.in.events} → {v.out.events} events, {kb(v.in.bytes)} → {kb(v.out.bytes)} ({measuredPct(v)} % smaller) on this article's sample{v.in.events > 1 ? ' and test events' : ''}.</div>
            : <div className="sx-todo">Not checked in Cribl yet.</div>}
          <ol className="sx-steps">{pipe.functions.map((f, k) => (
            <li key={k}><b>{FUNCTION_NAMES[f.id] || f.id}</b>{f.description ? ` — ${f.description}` : ''}
              {f.filter && f.filter !== 'true' ? <code>filter: {f.filter}</code> : null}
              {f.id !== 'serde' && f.id !== 'serialize' ? <code>{describe(f).replace(/^[^:]*:\s*/, '')}</code> : null}
            </li>
          ))}</ol>
          <details className="sx-json"><summary>Show JSON</summary><pre>{copy.all}</pre></details>
          <div className="sx-actions">
            <CopyButton className="sx-copy" text={copy.all} label="Copy pipeline JSON" />
            <CopyButton className="sx-copy" text={copy.own} label="Copy functions only" />
            <span>Parses the {log.type} log as {(log.format || '').toUpperCase()}. In Cribl Stream: Processing › Pipelines › Add Pipeline › Manage as JSON, then paste.</span>
          </div>
        </>
      ) : null}
      {st.routes?.length ? (
        <table className="ftable sx-routes"><tbody>
          <tr><th>Route</th><th>Filter</th><th>Send to</th></tr>
          {st.routes.map((r) => <tr key={r.name}><td>{r.name}</td><td><code>{r.filter}</code></td><td>{r.to}{r.final ? '' : ' (not final)'}</td></tr>)}
        </tbody></table>
      ) : null}
    </div>
  );
}

function CopyKql({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy KQL');
  return (
    <button type="button" className="copy" onClick={() => {
      // The Cribl iframe may refuse clipboard access; then the button just says so.
      navigator.clipboard?.writeText(text).then(() => setLabel('Copied'), () => setLabel('Copy failed'));
      setTimeout(() => setLabel('Copy KQL'), 1200);
    }}>{label}</button>
  );
}

function Raw({ log, fields, sel, onSelect }: { log: LogSample; fields: DecoratedField[]; sel: number | null; onSelect: (i: number) => void }) {
  if (!fields.length) return <div className="raw">{log.sample}</div>;
  const sep = SEP[log.format] || ' ';
  return (
    <div className="raw">
      {fields.map((f, i) => (
        <span key={f.i}>
          {i > 0 ? <span className="lc">{sep}</span> : null}
          <span className={`lf ${f.key ? 'k' : ''} ${f.noise ? 'n' : ''} ${sel === f.i ? 'sel' : ''}`} title={`${f.i}: ${f.name}`} onClick={() => onSelect(f.i)}>{f.text || <i>∅</i>}</span>
        </span>
      ))}
    </div>
  );
}

function LogView({ e, logi, onLog }: { e: Entry; logi: number; onLog: (i: number) => void }) {
  const logs = e.logs || [];
  const l = logs[logi] || logs[0];
  const [sel, setSel] = useState<number | null>(null);
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => { setSel(null); }, [l]);
  useEffect(() => {
    if (sel == null) return;
    table.current?.querySelector(`tr[data-i="${sel}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [sel]);
  if (!l) return null;
  const fields = decorate(l);
  const drop = fields.filter((f) => f.noise || !f.value).reduce((a, f) => a + f.value.length + 1, 0);
  const pct = Math.min(100, Math.round((drop / Math.max(l.sample.length, 1)) * 100));
  return (
    <>
      <div className="logsw">
        {logs.map((x, i) => (
          <Go key={x.type + i} to={() => onLog(i)} className={x === l ? 'on' : ''}>{x.type} <span style={{ opacity: .6, fontWeight: 400 }}>{x.share || ''}</span></Go>
        ))}
      </div>
      <div className="box">
        <h2>{l.type} log <span className="st">{l.sourcetype}</span></h2>
        <p>{l.desc}{l.avg ? ` · avg ${l.avg}/event` : ''}</p>
        <div className="two" style={{ marginTop: 12 }}>
          <div>
            <Raw log={l} fields={fields} sel={sel} onSelect={setSel} />
            <p style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: 8 }}>Click a value to find it in the field list. <span style={{ color: '#0b7f7e' }}>Teal</span> = key field, grey = droppable noise.</p>
            <div className="save"><span>Noise + empty fields in this event:</span><div className="bar"><i style={{ width: `${pct}%` }} /></div><b style={{ color: '#16a34a' }}>{pct}%</b></div>
          </div>
          <div className="scroll">
            <table className="ftable mono" ref={table}>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.i} data-i={f.i} className={`${f.noise ? 'n' : ''} ${sel === f.i ? 'sel' : ''}`}>
                    <td>{f.i}</td>
                    <td style={{ color: f.key ? '#0b7f7e' : 'inherit', fontWeight: f.key ? 700 : 400 }}>{f.name}</td>
                    <td>{f.value || <span style={{ color: '#cbd5e1' }}>∅ empty</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function Article({ lib, id, tab, logi, onTab, onLog, onOpen, onBrowse, onBuild }: {
  lib: Library; id: string; tab: Tab; logi: number;
  onTab: (t: Tab) => void; onLog: (i: number) => void; onOpen: (id: string) => void;
  onBrowse: (cat: string | null) => void; onBuild: (e: Entry) => void;
}) {
  const { entries, categories } = lib;
  const card = entries.find((x) => x.id === id);
  // The browse index has no article bodies: the full article is fetched when it opens.
  const { entry: e, error } = useFullEntry(lib, id);
  if (!card) return <div className="page"><h1>No such device</h1><p><Go to={() => onBrowse(null)}>Back to the library</Go></p></div>;
  if (error) return <div className="page"><h1>Could not load this article</h1><p>{error}.</p><p><Go to={() => onBrowse(null)}>Back to the library</Go></p></div>;
  if (!e) return <div className="page"><p>Loading article…</p></div>;
  const c = categoryOf(categories, e.category);
  const full = e.status === 'full';
  const shown: Tab = full ? tab : 'overview';
  const kev = (e.cves || []).filter((x) => x.kev).length;
  const traffic = (e.logs || [])[0];
  const byId = (rid: string) => entries.find((x) => x.id === rid);
  const build = <button type="button" className="gp-build" onClick={() => onBuild(e)}>⇶ Build a pack</button>;
  return (
    <>
      <div className="ahead"><div className="in">
        <div className="crumb">
          <Go to={() => onBrowse(null)}>Goatpedia</Go> › <Go to={() => onBrowse(e.category)}>{c.label}</Go> › <span>{e.vendor}</span>
        </div>
        <div className="title">
          {e.logo ? <div className="ico logo-ico"><Logo entry={e} /></div> : <div className="ico" style={{ background: `${c.color}22` }}>{c.icon}</div>}
          <div><h1>{e.name}</h1><div className="v">{e.vendor} · {c.label}{e.aka?.length ? ` · aka ${e.aka.join(', ')}` : ''}</div></div>
        </div>
        <div className="lede">{e.summary}</div>
        {full && traffic ? (
          <div className="glance">
            <div><small>Sourcetypes</small><b>{e.sourcetypes.length}</b> · <span className="st">{e.sourcetypes[0].st}</span></div>
            <div><small>Log format</small><b>{traffic.format.toUpperCase()}</b></div>
            <div><small>Main volume</small><b>{traffic.type} {traffic.share || ''}</b></div>
            <div><small>Known CVEs</small><b style={{ color: '#b91c1c' }}>{(e.cves || []).length}{kev ? ` · ${kev} KEV` : ''}</b></div>
            <div><small>Optimizations</small><b style={{ color: '#16a34a' }}>{(e.optimizations || []).length} techniques</b></div>
          </div>
        ) : null}
      </div></div>
      <div className="tabwrap"><div className="tabs">
        {full ? TABS.map(([k, label, n]) => (
          <Go key={k} to={() => onTab(k)} className={shown === k ? 'on' : ''}>
            {label}{n && e[n]?.length ? <span className="n">{e[n]!.length}</span> : null}
          </Go>
        )) : null}
        {build}
      </div></div>
      <div className="body">
        {!full ? (
          <>
            <div className="box"><h2>Sourcetypes</h2>{e.sourcetypes.map((s) => <span className="st" key={s.st}>{s.st}</span>)}</div>
            {cveIds(e).length ? <div className="box"><h2>Known CVEs</h2>{cveIds(e).map((x) => <a className="sig" key={x} href={`https://nvd.nist.gov/vuln/detail/${x}`} target="_blank" rel="noopener">{x}</a>)}</div> : null}
            <div className="stub"><b>This device only has a summary so far.</b><br />How it works, network placement, sample logs, CVEs, detections and optimizations are still to be written.</div>
          </>
        ) : shown === 'network' ? (
          <>
            <div className="box"><h2>Where it sits in the network</h2><div dangerouslySetInnerHTML={{ __html: diagramSvg(e) }} /></div>
            <div className="two">{(e.placement?.items || []).map((p, i) => <div className="box" key={p.title}><h4><span className="num">{i + 1}</span>{p.title}</h4><p>{p.desc}</p></div>)}</div>
            <div className="box"><h2>What traffic it handles</h2>
              <div style={{ marginBottom: 12 }}>{(e.traffic?.handles || []).map((h) => <span className="sig" key={h}>{h}</span>)}</div>
              <h4 style={{ marginBottom: 8 }}>Packet flow</h4>
              <div className="flow">{(e.traffic?.flow || []).map((f, i) => <div key={f.step}><b>{i + 1}. {f.step}</b>{f.desc}</div>)}</div>
            </div>
          </>
        ) : shown === 'logs' ? <LogView e={e} logi={logi} onLog={onLog} />
          : shown === 'cves' ? (
            <div className="box"><h2>Known vulnerabilities <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13 }}>— the device itself and the traffic it protects</span></h2>
              {(e.cves || []).map((v) => (
                <div className="cve" key={v.id}>
                  <div><div className="score" style={{ background: cvssColor(v.cvss ?? 0) }}>{(v.cvss ?? 0).toFixed(1)}<small>CVSS</small></div>{v.kev ? <div style={{ textAlign: 'center', marginTop: 6 }}><span className="b" style={{ background: '#fee2e2', color: '#b91c1c', fontSize: 11 }}>CISA KEV</span></div> : null}</div>
                  <div>
                    <h4><a href={`https://nvd.nist.gov/vuln/detail/${v.id}`} target="_blank" rel="noopener">{v.id}</a> — {v.title}</h4>
                    <div className="kv">
                      <b>Scope</b><span>{v.scope === 'device' ? 'The device itself' : 'Traffic type it protects'}</span>
                      <b>Affected</b><span>{v.affected}</span>
                      {v.fixed ? <><b>Fixed in</b><span>{v.fixed}</span></> : null}
                      <b>How to identify</b><span>{v.detect}</span>
                      <b>Avoid / mitigate</b><span>{v.avoid}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : shown === 'detect' ? (e.detections || []).map((d) => (
            <div className="box" key={d.title}>
              <CopyKql text={d.kql} />
              <h4><span className="b" style={{ background: sevColor(d.severity), color: '#fff' }}>{d.severity}</span> {d.title}</h4>
              <p>{d.why}</p>
              <div>{d.signals.map((s) => <span className="sig" key={s}>{s}</span>)}</div>
              {d.mitre?.length ? <div className="mitre">MITRE ATT&amp;CK: {d.mitre.map((t) => <a key={t} href={mitreUrl(t)} target="_blank" rel="noopener">{t}</a>).reduce<ReactNode[]>((a, node, i) => (i ? [...a, ' · ', node] : [node]), [])}</div> : null}
              <pre className="kql">{d.kql}</pre>
            </div>
          )) : shown === 'optimize' ? (
            <div className="box"><h2>Reduce volume without losing signal</h2>
              {(e.optimizations || []).map((o) => (
                <div className="opt" key={o.title}><div className="pct">{o.saving}<small>typical saving</small>{o.verified?.ok ? <small className="measured">{measuredPct(o.verified)} % measured</small> : null}</div>
                  <div><h4>{o.title} <span className="st">{o.fn}</span></h4><p>{o.how}</p>{o.stream ? <StreamBlockView e={e} o={o} /> : o.expr ? <code className="st" style={{ display: 'inline-block' }}>{o.expr}</code> : null}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="two">{(e.howItWorks || []).map((h) => <div className="box" key={h.title}><h4>{h.title}</h4><p>{h.body}</p></div>)}</div>
              <div className="box"><h2>Sourcetypes</h2>
                <table className="ftable"><tbody>{e.sourcetypes.map((s) => <tr key={s.st}><td style={{ width: 220 }}><span className="st">{s.st}</span></td><td>{s.desc || ''}</td></tr>)}</tbody></table>
              </div>
              <div className="box"><h2>Key facts</h2><div className="kv">{Object.entries(e.facts || {}).map(([k, v]) => <span key={k} style={{ display: 'contents' }}><b>{k}</b><span>{v}</span></span>)}</div></div>
              {(e.related || []).length ? <div className="box"><h2>Related</h2>{(e.related || []).map((r) => { const rel = byId(r); return rel ? <Go className="st" key={r} to={() => onOpen(r)}>{rel.name}</Go> : null; })}</div> : null}
              {(e.references || []).length ? <div className="box"><h2>References</h2><ul className="refs">{(e.references || []).map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener">{r.title}</a></li>)}</ul></div> : null}
            </>
          )}
      </div>
    </>
  );
}

export default function GoatpediaPage({ onBuildPack }: { onBuildPack: (entry: Entry) => void }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let gone = false;
    setLib(null);
    setError(null);
    loadLibrary()
      .then((next) => { if (!gone) setLib(next); })
      .catch((err: unknown) => { if (!gone) setError(err instanceof Error ? err.message : 'The library could not be loaded'); });
    return () => { gone = true; };
  }, [attempt]);

  // A new article, browse page or results page starts at the top; a tab or log switch keeps the place.
  const viewKey = view.kind === 'browse' ? `browse:${page}` : view.id;
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [viewKey]);

  const open = (id: string) => setView({ kind: 'article', id, tab: 'overview', log: 0 });
  // A new search or category starts again at page 1; going back to browse keeps the page.
  const browse = (c: string | null) => { if (c !== cat) { setCat(c); setPage(1); } setView({ kind: 'browse' }); };
  const query = (next: string) => { setQ(next); setPage(1); };
  const pickCat = (c: string | null) => { setCat(c); setPage(1); };

  return (
    <div className="goatpedia" ref={scroller}>
      {error ? (
        <div className="page">
          <h1>Could not load the library</h1>
          <p>{error}. The articles live in the Goatpedia git repository, and this screen reads the copy GitHub publishes from it.</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          {' '}<a className="btn" href={SITE_URL} target="_blank" rel="noopener">Open the public site</a>
        </div>
      ) : !lib ? (
        <div className="page"><p>Loading library…</p></div>
      ) : view.kind === 'browse' ? (
        <Browse lib={lib} q={q} cat={cat} page={page} onQuery={query} onCat={pickCat} onPage={setPage} onOpen={open} />
      ) : (
        <Article lib={lib} id={view.id} tab={view.tab} logi={view.log}
          onTab={(tab) => setView({ ...view, tab, log: 0 })}
          onLog={(log) => setView({ ...view, tab: 'logs', log })}
          onOpen={open} onBrowse={browse} onBuild={onBuildPack} />
      )}
    </div>
  );
}
