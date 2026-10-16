export interface SearchDatatypeDescriptor {
  id: string;
  lib: 'custom';
  description: string;
  tags: string;
  dataFormat: 'ndjson' | 'kvp' | 'delimited' | 'raw' | 'xml';
  automaticExtraction?: Record<string, unknown>;
  additionalExtractions?: Array<{
    name: string;
    sourceField: string;
    extractionType: 'regexp';
    regexpList: Array<{ regexp: string; overwrite?: boolean }>;
  }>;
  timestampExtraction: {
    type: 'auto';
    sourceField: '_raw';
    timezone: 'UTC';
    earliest: '0';
    latest: '+10years';
    scanDepth: 150;
  };
  addFields: Array<{ fieldName: string; source: string }>;
}

interface StreamFunction {
  id: string;
  disabled?: boolean | null;
  conf?: Record<string, unknown>;
}

export interface ExistingSearchDatatype {
  id: string;
  dataFormat: string;
  automaticExtraction?: Record<string, unknown>;
  additionalExtractions?: unknown[];
  schemaMap?: unknown[];
  addFields?: unknown[];
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'source';

function firstNonEmptyLine(sampleEvents: string): string {
  return sampleEvents.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() || '';
}

function isJsonSample(sampleEvents: string): boolean {
  const line = firstNonEmptyLine(sampleEvents);
  if (!line.startsWith('{')) return false;
  try { return !!JSON.parse(line); } catch { return false; }
}

function isXmlSample(sampleEvents: string): boolean {
  const line = firstNonEmptyLine(sampleEvents);
  return line.startsWith('<') && line.endsWith('>');
}

function looksLikeCsv(sampleEvents: string, fields: string[]): boolean {
  const lines = sampleEvents.split(/\r?\n/).filter(Boolean).slice(0, 3);
  if (lines.length === 0 || fields.length < 2) return false;
  const commaCounts = lines.map(line => (line.match(/,/g) || []).length);
  return commaCounts[0] >= 1 && commaCounts.every(count => count === commaCounts[0]);
}

function looksLikeKvp(sampleEvents: string): boolean {
  const line = firstNonEmptyLine(sampleEvents);
  return (line.match(/(?:^|\s)[A-Za-z_][\w.-]*=/g) || []).length >= 2;
}

function stripRegexDelimiters(value: string): string {
  const match = value.match(/^\/(.*)\/[a-z]*$/s);
  return (match ? match[1] : value).replace(/\(\?<([A-Za-z_$][\w$]*)>/g, '(?P<$1>');
}

function regexExtractions(functions: StreamFunction[]): SearchDatatypeDescriptor['additionalExtractions'] {
  return functions.flatMap((fn, index) => {
    if (fn.disabled || fn.id !== 'regex_extract' || typeof fn.conf?.regex !== 'string') return [];
    const sourceField = typeof fn.conf.source === 'string'
      ? fn.conf.source
      : typeof fn.conf.sourceField === 'string' ? fn.conf.sourceField : '_raw';
    return [{
      name: `demo_regex_${index + 1}`,
      sourceField,
      extractionType: 'regexp' as const,
      regexpList: [{ regexp: stripRegexDelimiters(fn.conf.regex), overwrite: false }],
    }];
  });
}

function addObjectFields(value: unknown, fields: Set<string>, prefix = ''): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(path)) fields.add(path);
    addObjectFields(child, fields, path);
  }
}

/** Infer only fields an existing Datatype promises to extract from this sample. */
export function inferSearchDatatypeFields(datatype: ExistingSearchDatatype, sampleEvents: string): string[] {
  const fields = new Set<string>(['_time', 'datatype', 'sourcetype']);
  const automaticType = String(datatype.automaticExtraction?.extractionType || '');
  const fieldList = datatype.automaticExtraction?.fieldList;
  if (Array.isArray(fieldList)) fieldList.filter(field => typeof field === 'string').forEach(field => fields.add(field));

  if (automaticType === 'json' || datatype.dataFormat === 'ndjson') {
    for (const line of sampleEvents.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
      try { addObjectFields(JSON.parse(line), fields); } catch { /* ignore malformed sample lines */ }
    }
  } else if (automaticType === 'kvp' || datatype.dataFormat === 'kvp') {
    for (const match of sampleEvents.matchAll(/(?:^|\s)([A-Za-z_$][\w$.-]*)=/gm)) fields.add(match[1]);
  } else if (automaticType === 'xml' || datatype.dataFormat === 'xml') {
    for (const match of sampleEvents.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s|>)/g)) fields.add(match[1].replace(/:/g, '_'));
  }

  for (const extraction of Array.isArray(datatype.additionalExtractions) ? datatype.additionalExtractions : []) {
    const item = extraction as Record<string, unknown>;
    for (const regexItem of Array.isArray(item.regexpList) ? item.regexpList : []) {
      const regexp = String((regexItem as Record<string, unknown>).regexp || '');
      for (const match of regexp.matchAll(/\(\?P?<([A-Za-z_$][\w$]*)>/g)) fields.add(match[1]);
    }
  }
  for (const mapping of [...(Array.isArray(datatype.schemaMap) ? datatype.schemaMap : []), ...(Array.isArray(datatype.addFields) ? datatype.addFields : [])]) {
    const fieldName = (mapping as Record<string, unknown>)?.fieldName;
    if (typeof fieldName === 'string') fields.add(fieldName);
  }
  return [...fields].sort();
}

/** Build a Search Datatype v1 from the exact sample/parser used by demo processing. */
export function buildSearchDatatype(
  sourcetype: string,
  sampleEvents: string,
  parserFunctions: StreamFunction[] = [],
  parsedFieldNames: string[] = [],
): SearchDatatypeDescriptor {
  const id = `demo_${slug(sourcetype)}_datatype`;
  const serdeFields = parserFunctions.find(fn => fn.id === 'serde' && Array.isArray(fn.conf?.fields))?.conf?.fields;
  const candidateFields = Array.isArray(serdeFields) ? serdeFields : parsedFieldNames;
  const fields = [...new Set(candidateFields.filter((field): field is string => typeof field === 'string' && /^[A-Za-z_$][\w$.-]*$/.test(field)))];
  const additionalExtractions = regexExtractions(parserFunctions);
  let dataFormat: SearchDatatypeDescriptor['dataFormat'] = 'raw';
  let automaticExtraction: Record<string, unknown> | undefined;

  if (isJsonSample(sampleEvents)) {
    dataFormat = 'ndjson';
    automaticExtraction = { extractionType: 'json' };
  } else if (isXmlSample(sampleEvents)) {
    dataFormat = 'xml';
    automaticExtraction = { extractionType: 'xml' };
  } else if (looksLikeKvp(sampleEvents)) {
    dataFormat = 'kvp';
    automaticExtraction = { extractionType: 'kvp', delimiter: ' ', equals: '=' };
  } else if (looksLikeCsv(sampleEvents, fields)) {
    dataFormat = 'delimited';
    automaticExtraction = { extractionType: 'delimited', delimiter: ',', quote: '"', fieldList: fields };
  }

  return {
    id,
    lib: 'custom',
    description: `Demo Datatype v1 for ${sourcetype}; generated from the processing sample.`,
    tags: `demo,${sourcetype}`,
    dataFormat,
    ...(automaticExtraction ? { automaticExtraction } : {}),
    ...(additionalExtractions?.length ? { additionalExtractions } : {}),
    timestampExtraction: {
      type: 'auto', sourceField: '_raw', timezone: 'UTC', earliest: '0', latest: '+10years', scanDepth: 150,
    },
    addFields: [
      { fieldName: 'datatype', source: `'${id}'` },
      { fieldName: 'sourcetype', source: `'${sourcetype.replace(/'/g, "\\'")}'` },
    ],
  };
}
