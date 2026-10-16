import { AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';
import { withGeneratedSampleCache } from './generated-sample-cache.mjs';

export async function handleFetchPublicSamples(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { url, format, maxEvents = 100 } = JSON.parse(body);

    if (!url) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CriblPackGenerator/1.0' },
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
    }

    const text = await resp.text();
    let events = [];

    if (format === 'json') {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          events = parsed.map(e => typeof e === 'string' ? e : (e._raw || JSON.stringify(e)));
        } else {
          // NDJSON
          events = text.trim().split('\n').filter(Boolean).map(line => {
            try {
              const obj = JSON.parse(line);
              return obj._raw || JSON.stringify(obj);
            } catch {
              return line;
            }
          });
        }
      } catch {
        // Fallback: treat as line-delimited
        events = text.trim().split('\n').filter(Boolean);
      }
    } else {
      // Text format: one event per line
      events = text.trim().split('\n').filter(Boolean);
    }

    // Cap at maxEvents
    if (events.length > maxEvents) {
      events = events.slice(0, maxEvents);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events, count: events.length, source: url }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Fetch failed' }));
  }
}

export async function handleHybridSamples(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { url, format, sourcetype, count = 100 } = JSON.parse(body);

    const response = await withGeneratedSampleCache(
      { source: 'hybrid', sourcetype, count, mode: 'hybrid', url, format },
      async () => {

    // Step 1: Fetch seed samples from public source
    let seedEvents = [];
    if (url) {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'CriblPackGenerator/1.0' },
      });
      if (resp.ok) {
        const text = await resp.text();
        if (format === 'json') {
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
              seedEvents = parsed.map(e => typeof e === 'string' ? e : (e._raw || JSON.stringify(e)));
            } else {
              seedEvents = text.trim().split('\n').filter(Boolean).map(line => {
                try { return JSON.parse(line)._raw || line; } catch { return line; }
              });
            }
          } catch {
            seedEvents = text.trim().split('\n').filter(Boolean);
          }
        } else {
          seedEvents = text.trim().split('\n').filter(Boolean);
        }
      }
    }

    // Take up to 10 seed events as examples
    const seedSample = seedEvents.slice(0, 10).join('\n');
    const seedCount = Math.min(seedEvents.length, 20);
    const aiCount = Math.max(count - seedCount, count - 20);

    // Step 2: Use AI to generate more events in the same format
    const systemPrompt = `You are a log generator. You will be given real sample events from a ${sourcetype} data source. Generate MORE events in the EXACT same format — same field names, same structure, same delimiters — but with different values.

Requirements:
- Match the format EXACTLY (same fields, same order, same delimiters, same quoting)
- Vary: timestamps (24h window), IPs (mix internal/external), users, hostnames, event types
- Mix: successes AND failures, routine AND security-relevant events
- Include edge cases: unusual ports, large byte counts, empty optional fields, IPv6
- Each event must be unique and plausible to a SOC analyst
- Return ONLY raw events, one per line. No markdown, no numbering, no explanation.`;

    const userPrompt = `Here are ${seedEvents.slice(0, 10).length} real ${sourcetype} events as reference:

${seedSample}

Generate exactly ${aiCount} MORE events in the same format. Different values, same structure. Include both normal and suspicious activity.
Return raw events only, one per line.`;

    const aiText = await invokeModel(MODEL_ID, systemPrompt, userPrompt, 16000);

    const aiEvents = aiText
      .replace(/^```[a-z]*\n?/gm, '')
      .replace(/^```\s*$/gm, '')
      .trim()
      .split('\n')
      .filter(l => l.trim().length > 0);

    // Step 3: Combine seed events + AI-generated events
    const combined = [...seedEvents.slice(0, seedCount), ...aiEvents];

    // Cap at 2 MB
    const MAX_BYTES = 2_097_152;
    let totalBytes = 0;
    let finalEvents = [];
    for (const evt of combined) {
      totalBytes += Buffer.byteLength(evt, 'utf8') + 1;
      if (totalBytes > MAX_BYTES) break;
      finalEvents.push(evt);
    }

        return {
          events: finalEvents,
          count: finalEvents.length,
          seedCount: Math.min(seedEvents.length, seedCount),
          aiCount: aiEvents.length,
        };
      },
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Hybrid generation failed' }));
  }
}
