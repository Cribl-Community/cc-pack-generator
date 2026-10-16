export type DashboardStyle = 'native' | 'vizlab';

export type DashboardMetric = 'count' | 'distinct' | 'sum' | 'avg' | 'p95';
export type DashboardVisualization = 'single' | 'line' | 'bar' | 'pie' | 'table' | 'sankey' | 'treemap';

export interface DashboardKpi {
  id: string;
  title: string;
  visualization: DashboardVisualization;
  metric: DashboardMetric;
  field?: string;
  groupBy?: string;
  secondaryGroupBy?: string;
  reason: string;
}

export interface DashboardPlan {
  title: string;
  summary: string;
  kpis: DashboardKpi[];
  selectionMode?: 'ai' | 'sample-fallback';
}

const FIELD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'demo';
const quoteDataset = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function collectDatasetFields(events: Record<string, unknown>[]): string[] {
  const fields = new Set<string>();
  const visit = (value: unknown, prefix = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (FIELD_RE.test(path)) fields.add(path);
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, path);
    }
  };
  events.forEach(event => visit(event));
  return [...fields].sort();
}

export function normalizeDashboardPlan(raw: any, availableFields: string[], datasetId: string): DashboardPlan {
  const allowed = new Set(availableFields);
  const visualizations = new Set<DashboardVisualization>(['single', 'line', 'bar', 'pie', 'table', 'sankey', 'treemap']);
  const metrics = new Set<DashboardMetric>(['count', 'distinct', 'sum', 'avg', 'p95']);
  const used = new Set<string>();
  const kpis: DashboardKpi[] = [];

  for (const item of Array.isArray(raw?.kpis) ? raw.kpis : []) {
    if (!item || typeof item.title !== 'string' || typeof item.reason !== 'string') continue;
    const visualization = visualizations.has(item.visualization) ? item.visualization as DashboardVisualization : 'bar';
    const metric = metrics.has(item.metric) ? item.metric as DashboardMetric : 'count';
    const field = typeof item.field === 'string' && allowed.has(item.field) ? item.field : undefined;
    const groupBy = typeof item.groupBy === 'string' && allowed.has(item.groupBy) ? item.groupBy : undefined;
    const secondaryGroupBy = typeof item.secondaryGroupBy === 'string' && allowed.has(item.secondaryGroupBy) ? item.secondaryGroupBy : undefined;
    if (metric !== 'count' && !field) continue;
    if (['bar', 'pie', 'sankey', 'treemap'].includes(visualization) && !groupBy) continue;
    if (visualization === 'sankey' && !secondaryGroupBy) continue;
    const id = slug(String(item.id || item.title));
    if (used.has(id)) continue;
    used.add(id);
    kpis.push({ id, title: item.title.slice(0, 80), visualization, metric, field, groupBy, secondaryGroupBy, reason: item.reason.slice(0, 240) });
    if (kpis.length === 7) break;
  }

  if (kpis.length < 3) throw new Error('AI did not produce at least three usable KPIs from the observed dataset fields.');
  return {
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : `${datasetId} Demo Overview`,
    summary: typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 400) : `AI-selected operational KPIs for ${datasetId}.`,
    kpis,
    selectionMode: raw?.selectionMode === 'sample-fallback' ? 'sample-fallback' : 'ai',
  };
}

export function buildSampleFallbackDashboardPlan(availableFields: string[], datasetId: string): DashboardPlan {
  const fields = [...new Set(availableFields)];
  const usable = fields.filter(field => !['_time', '_raw', 'datatype', 'sourcetype'].includes(field));
  const categorical = usable.filter(field => /(action|status|severity|category|type|protocol|application|user|host|zone|country|ip)$/i.test(field));
  const numeric = usable.filter(field => /(bytes|size|duration|latency|elapsed|count|packets|port)$/i.test(field));
  const groups = [...new Set([...categorical, ...usable, 'sourcetype', 'datatype'])];
  const raw = {
    title: `${datasetId} Demo Overview`,
    summary: `Sample-derived operational KPIs for ${datasetId}. AI was unavailable during deployment.`,
    selectionMode: 'sample-fallback',
    kpis: [
      { id: 'total_events', title: 'Total Events', visualization: 'single', metric: 'count', reason: 'Shows total activity.' },
      { id: 'events_over_time', title: 'Events Over Time', visualization: 'line', metric: 'count', reason: 'Shows activity trends.' },
      ...groups.slice(0, 3).map((field, index) => ({
        id: `top_${field}`, title: `Top ${field.replace(/_/g, ' ')}`, visualization: index === 1 ? 'pie' : 'bar', metric: 'count', groupBy: field,
        reason: `Shows the most common ${field} values extracted from the processing sample.`,
      })),
      ...(numeric[0] ? [{
        id: `average_${numeric[0]}`, title: `Average ${numeric[0].replace(/_/g, ' ')}`, visualization: 'single', metric: 'avg', field: numeric[0],
        reason: `Tracks the average extracted ${numeric[0]} value.`,
      }] : []),
    ],
  };
  return normalizeDashboardPlan(raw, fields, datasetId);
}

function aggregation(kpi: DashboardKpi, alias = 'value'): string {
  if (kpi.metric === 'count') return `${alias}=count()`;
  if (kpi.metric === 'distinct') return `${alias}=dcount(${kpi.field})`;
  if (kpi.metric === 'sum') return `${alias}=sum(${kpi.field})`;
  if (kpi.metric === 'avg') return `${alias}=avg(${kpi.field})`;
  return `${alias}=percentile(${kpi.field}, 95)`;
}

function childQuery(kpi: DashboardKpi): string {
  if (kpi.visualization === 'line') return `| timestats span=1h ${aggregation(kpi)}`;
  if (kpi.visualization === 'table') {
    const fields = [...new Set(['_time', kpi.groupBy, kpi.field].filter(Boolean))].join(', ');
    return `| project ${fields || '_time, _raw'}\n| sort by _time desc\n| limit 50`;
  }
  if (kpi.visualization === 'sankey') return `| summarize ${aggregation(kpi)} by ${kpi.groupBy}, ${kpi.secondaryGroupBy}\n| sort by value desc\n| limit 30`;
  if (kpi.visualization === 'treemap') return `| summarize ${aggregation(kpi)} by ${kpi.groupBy}${kpi.secondaryGroupBy ? `, ${kpi.secondaryGroupBy}` : ''}\n| sort by value desc\n| limit 30`;
  if (kpi.groupBy) return `| summarize ${aggregation(kpi)} by ${kpi.groupBy}\n| sort by value desc\n| limit 15`;
  return `| summarize ${aggregation(kpi)}`;
}

export function buildNativeDashboard(datasetId: string, plan: DashboardPlan): Record<string, unknown> {
  const parentId = 'parent_demo_dataset';
  const elements: any[] = [
    {
      id: 'time_input', inputId: 'TIME', type: 'input.timerange', variant: 'input', title: 'Time Range',
      layout: { x: 0, y: 0, w: 3, h: 2 },
      config: { defaultValue: { earliest: '-24h', latest: 'now', timezone: 'local' } },
    },
    {
      id: 'dashboard_context', type: 'markdown.default', variant: 'markdown', layout: { x: 0, y: 2, w: 12, h: 1 },
      config: { markdown: `## ${plan.title}\n${plan.summary}` },
    },
    {
      id: parentId, type: 'list.events', title: 'Demo dataset base search', hidePanel: true,
      layout: { x: 0, y: 3, w: 4, h: 2 },
      search: { type: 'inline', query: `dataset="${quoteDataset(datasetId)}"`, earliest: '$TIME.earliest$', latest: '$TIME.latest$', timezone: '$TIME.timezone$' },
      config: {},
    },
  ];

  plan.kpis.forEach((kpi, index) => {
    const type = kpi.visualization === 'line' ? 'chart.line'
      : kpi.visualization === 'pie' ? 'chart.pie'
        : kpi.visualization === 'table' ? 'list.table'
          : kpi.visualization === 'bar' ? 'chart.horizontalBar'
            : 'chart.column';
    const chartConfig = type.startsWith('chart.') ? { colorPalette: index % 8, axis: {} } : {};
    elements.push({
      id: `kpi_${kpi.id}`, title: kpi.title, type,
      layout: { x: (index % 3) * 4, y: 3 + Math.floor(index / 3) * 4, w: 4, h: 4 },
      parentSearchId: parentId,
      search: { type: 'inline', query: childQuery(kpi), earliest: 0, latest: 'now', parentSearchId: parentId },
      config: chartConfig,
    });
  });

  const id = `demo_${slug(datasetId)}_overview`;
  return {
    id,
    schedule: { enabled: false, cronSchedule: '0 0 * * *', tz: 'UTC', keepLastN: 2 },
    groups: {},
    name: plan.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80) || `${datasetId} Demo Overview`,
    elements,
  };
}

function vizlabQuery(datasetId: string, kpi: DashboardKpi): string {
  const base = `dataset="${quoteDataset(datasetId)}"`;
  if (kpi.visualization === 'line') return `${base}\n| timestats span=1h ${aggregation(kpi)}\n| project time=_time, value`;
  if (kpi.visualization === 'table') return `${base}\n${childQuery(kpi)}`;
  if (kpi.visualization === 'sankey') return `${base}\n| summarize ${aggregation(kpi)} by ${kpi.groupBy}, ${kpi.secondaryGroupBy}\n| extend source=${kpi.groupBy}, target=${kpi.secondaryGroupBy}\n| project source, target, value\n| sort by value desc\n| limit 30`;
  if (kpi.visualization === 'treemap') return `${base}\n| summarize ${aggregation(kpi)} by ${kpi.groupBy}${kpi.secondaryGroupBy ? `, ${kpi.secondaryGroupBy}` : ''}\n| extend level1=${kpi.groupBy}${kpi.secondaryGroupBy ? `, level2=${kpi.secondaryGroupBy}` : ''}\n| project level1${kpi.secondaryGroupBy ? ', level2' : ''}, value\n| sort by value desc\n| limit 30`;
  if (kpi.groupBy) return `${base}\n| summarize ${aggregation(kpi)} by ${kpi.groupBy}\n| extend category=${kpi.groupBy}\n| project category, value\n| sort by value desc\n| limit 15`;
  return `${base}\n| summarize ${aggregation(kpi)}\n| extend label="${kpi.title.replace(/"/g, '\\"')}"\n| project label, value`;
}

export function buildVizlabDashboard(datasetId: string, plan: DashboardPlan, now = Date.now()): Record<string, unknown> {
  const vizMap: Record<DashboardVisualization, string> = {
    single: 'single', line: 'line', bar: 'bar', pie: 'donut', table: 'table', sankey: 'sankey', treemap: 'treemap',
  };
  return {
    id: `d-demo-${slug(datasetId).replace(/_/g, '-')}`,
    name: `vz_${plan.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 77) || 'Demo Overview'}`,
    createdAt: now, updatedAt: now, cols: 12, rowHeight: 60, gap: 10, refreshSec: 0, theme: 'inherit', accent: 'teal',
    timeRange: { earliest: '-24h', latest: 'now', label: '-24h → now' },
    variables: [{ id: 'v-time', name: 'TIME', label: 'Time Range', type: 'time', default: '', current: '' }],
    widgets: plan.kpis.map((kpi, index) => ({
      id: `w-${kpi.id.replace(/_/g, '-').slice(0, 42)}`, title: kpi.title,
      x: (index % 3) * 4, y: Math.floor(index / 3) * 5, w: 4, h: 5,
      query: vizlabQuery(datasetId, kpi), hidePanel: false, options: { showTitle: true }, kind: 'viz', vizId: vizMap[kpi.visualization],
    })),
    version: 1, vizlab: true,
  };
}

export function dashboardQueriesForValidation(dashboard: any): string[] {
  if (dashboard?.vizlab === true) {
    return (Array.isArray(dashboard.widgets) ? dashboard.widgets : [])
      .map((widget: any) => widget?.query)
      .filter((query: unknown): query is string => typeof query === 'string' && query.trim().length > 0);
  }
  const elements = Array.isArray(dashboard?.elements) ? dashboard.elements : [];
  const parents = new Map<string, string>();
  for (const element of elements) {
    if (element?.hidePanel === true && typeof element?.search?.query === 'string') parents.set(element.id, element.search.query);
  }
  return elements.flatMap((element: any) => {
    const query = element?.search?.query;
    if (typeof query !== 'string' || element?.hidePanel === true || String(element?.type || '').startsWith('input.')) return [];
    const parentQuery = element.parentSearchId ? parents.get(element.parentSearchId) : undefined;
    return [parentQuery ? `${parentQuery}\n${query}` : query];
  });
}
