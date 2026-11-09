// Deep links into Cribl Stream's own UI for what a build deployed. Shapes, as
// Stream serves them (Cribl.Cloud and on-prem leaders alike):
//   <base>/stream/m/<group>/p/<pack>/routes
//   <base>/stream/m/<group>/p/<pack>/pipelines/<pipeline>
// `base` is the instance origin: `criblInstanceBaseUrl()` in the iframe, the
// configured CRIBL_ORG in standalone. Callers hide the link when it is null.

const seg = (s: string) => encodeURIComponent(s);

/** Origin with no trailing slash or `/api/v1`, or null for anything that is not an http(s) URL. */
export function normalizeCriblBase(base: string | null | undefined): string | null {
  const b = (base || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return /^https?:\/\/[^/\s]+/i.test(b) ? b : null;
}

/** The pack in Stream. Pack IDs are lowercased by Cribl, so the link is too. */
export function streamPackUrl(base: string | null | undefined, group: string, packId: string): string | null {
  const b = normalizeCriblBase(base);
  if (!b || !group || !packId) return null;
  return `${b}/stream/m/${seg(group)}/p/${seg(packId.toLowerCase())}/routes`;
}

/** One pipeline inside the pack. A `pack:pipeline` id is reduced to the pipeline part. */
export function streamPipelineUrl(base: string | null | undefined, group: string, packId: string, pipelineId: string): string | null {
  const b = normalizeCriblBase(base);
  const pid = (pipelineId || '').includes(':') ? pipelineId.split(':').pop()! : pipelineId;
  if (!b || !group || !packId || !pid) return null;
  return `${b}/stream/m/${seg(group)}/p/${seg(packId.toLowerCase())}/pipelines/${seg(pid)}`;
}
