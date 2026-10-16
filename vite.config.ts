import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from './scripts/pkgutil.mjs'
// @ts-ignore
import { handleDeploy, handlePatchPipeline, handleCommitDeploy } from './scripts/deploy-api.mjs'
// @ts-ignore
import { handleAiAdvise, handleAiAnalyzeTrace, handleAiMapping, handleAiParse } from './scripts/ai-advisor.mjs'
// @ts-ignore
import { handleAiExtendSample, handleAiSamples } from './scripts/ai-samples.mjs'
// @ts-ignore
import { handleAiHealth } from './scripts/ai-health.mjs'
// @ts-ignore
import { handleSchematizer } from './scripts/schematizer.mjs'
// @ts-ignore
import { handleAiValidate, handleDetectSourcetype } from './scripts/ai-validate.mjs'
// @ts-ignore
import { handleListGroups, handleListPacks, handleListPackPipelines, handleGetPackPipeline } from './scripts/list-packs.mjs'
// @ts-ignore
import { handleGetCreds, handleTestCreds, handleSaveCreds } from './scripts/cribl-auth.mjs'
// @ts-ignore
// @ts-ignore
import { handleLiveCapture, handleListInputs, handleListSamples, handleDownloadSample, handleUploadGroupSample, handleDeleteGroupSample, handleGetPackSample, handleUploadPackSample, handleDeletePackSample } from './scripts/live-capture.mjs'
// @ts-ignore
import { handleFetchPublicSamples, handleHybridSamples } from './scripts/fetch-samples.mjs'
// @ts-ignore
import { handleDebugSample } from './scripts/debug-sample-api.mjs'
// @ts-ignore
import { handleValidatePipeline, handleRepairPipeline, handlePreDeployValidate, handleGetGolden, handleSaveGolden, handleObserveGolden, handlePipelineProfile } from './scripts/schema-validator.mjs'
// @ts-ignore
import { handleReferenceCatalog, handleReferenceAvailability, handleReferenceSample, handleReferenceLookups, handleDatatypeAudit } from './scripts/reference-api.mjs'
// @ts-ignore
import { handleHealLookup } from './scripts/lookup-selfheal.mjs'
// @ts-ignore
import { handleLogScore, handleLakeHealth, handleLakeTestEvent } from './scripts/score-logger.mjs'
// @ts-ignore
import { handleRepairQuality } from './scripts/repair-core.mjs'
// @ts-ignore
import { handleGoldenAvailable, handleGoldenImport, handleGoldenPublish, handleGoldenTest, handleGoldenReconcile, handleGoldenPushable, handleGoldenPush } from './scripts/golden-github.mjs'
// @ts-ignore
import { handleSampleLibrary, handleSampleLibraryPromote, handleSampleLibraryReject, handleSampleLibraryDefer, handleSampleLibraryDiscard } from './scripts/sample-library-api.mjs'
// @ts-ignore
import { handleSanitisedSamples, handleSanitisedSampleSave, handleSanitisedSampleDelete } from './scripts/sanitised-sample-api.mjs'
// @ts-ignore
import { handleSanitisedSamplePublish, handleSanitisedSampleTest } from './scripts/sanitised-samples-github.mjs'
// @ts-ignore
import { handleListWorkers, handleListLakeDatasets, handleListSearchDatasets, handleListSearchDatatypes, handleDeploySearchDatatype, handleAttachSearchDatatypes, handleDeploySearchDashboard, handleListOutputs, handleEnsureLakeOutput, handleSetMasterRoutes, handleCreateDemoDatagen, handleScanDemo, handleCleanupDemo } from './scripts/demo-api.mjs'

function hasLegacyTokenQuery(req: IncomingMessage): boolean {
  return new URL(req.url || '/', 'http://localhost').searchParams.has('token')
}

export function isAllowedPackGeneratorPeer(
  remoteAddress: string | undefined,
  gateHeader: string | undefined,
  gateEnv: string | undefined,
): boolean {
  if (
    remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
  ) return true
  if (!gateEnv || gateHeader === undefined) return false

  const actual = Buffer.from(gateHeader)
  const expected = Buffer.from(gateEnv)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function decodePathnameForGate(pathname: string): string {
  let decoded = pathname
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return decoded
      decoded = next
    } catch {
      return decoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
    }
  }
  return decoded
}

export function isPackGeneratorApiPath(url: string | undefined): boolean {
  const raw = url || '/'
  let pathname: string
  try {
    pathname = new URL(raw, 'http://localhost').pathname
  } catch {
    pathname = raw.split(/[?#]/, 1)[0]
  }

  const normalized = decodePathnameForGate(pathname).replace(/\\/g, '/').toLowerCase()
  const prefix = '/api/pack-generator'
  const boundary = normalized[prefix.length]
  if (normalized.startsWith(prefix) && (!boundary || boundary === '/' || boundary === '.')) return true
  return false
}

export function isCrossSitePackGeneratorMutation(
  method: string | undefined,
  secFetchSite: string | undefined,
): boolean {
  const normalizedMethod = (method || 'GET').toUpperCase()
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return false
  return secFetchSite?.toLowerCase() === 'cross-site'
}

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

// Standalone dev CORS forwarder. External AI providers (OpenAI/Mistral/Azure/
// Gemini/Anthropic) build request URLs as `/proxy/<host>/<path>` — in iframe
// mode the Cribl platform proxy handles that prefix, but the dev server has no
// equivalent, so those calls 404'd. This forwards `/proxy/<host>/<rest>` to
// `https://<host>/<rest>`, passing method/headers/body straight through (the
// client already sets the provider auth header, e.g. x-goog-api-key for Gemini).
const corsProxyPlugin = () => ({
  name: 'vite-plugin-cors-proxy',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/proxy/', (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        try {
          // req.url here is the path AFTER '/proxy' (connect strips the mount prefix).
          const rest = (req.url || '').replace(/^\/+/, '')
          const slash = rest.indexOf('/')
          const host = slash === -1 ? rest : rest.slice(0, slash)
          const path = slash === -1 ? '' : rest.slice(slash)
          if (!host) { res.statusCode = 400; res.end('proxy: missing target host'); return }

          // Read the incoming body (POST/PUT).
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = chunks.length ? Buffer.concat(chunks) : undefined

          // Forward the provider auth + content headers; drop hop-by-hop/host ones.
          const fwdHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(req.headers)) {
            const lk = k.toLowerCase()
            if (['host', 'connection', 'content-length', 'origin', 'referer', 'accept-encoding'].includes(lk)) continue
            if (typeof v === 'string') fwdHeaders[k] = v
          }

          const upstream = await fetch(`https://${host}${path}`, {
            method: req.method || 'GET',
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
          })
          res.statusCode = upstream.status
          const ct = upstream.headers.get('content-type')
          if (ct) res.setHeader('Content-Type', ct)
          const text = await upstream.text()
          res.end(text)
        } catch (err) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: `proxy failed: ${(err as Error).message}` }))
        }
      })()
    })
  },
})

export const deployApiPlugin = () => ({
  name: 'vite-plugin-deploy-api',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (!isPackGeneratorApiPath(req.url)) {
        next()
        return
      }
      const fetchSite = req.headers['sec-fetch-site']
      if (isCrossSitePackGeneratorMutation(
        req.method,
        typeof fetchSite === 'string' ? fetchSite : undefined,
      )) {
        res.statusCode = 403
        res.end('Forbidden cross-site mutation')
        return
      }
      const gateHeader = req.headers['x-packgen-gate']
      const allowed = isAllowedPackGeneratorPeer(
        req.socket.remoteAddress,
        typeof gateHeader === 'string' ? gateHeader : undefined,
        process.env.PACKGEN_DEV_GATE,
      )
      if (allowed) {
        next()
        return
      }
      res.statusCode = 403
      res.end('Forbidden')
    })
    server.middlewares.use('/api/pack-generator/deploy', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleDeploy(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/patch-pipeline', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') { void handlePatchPipeline(req, res) } else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/commit-deploy', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') { void handleCommitDeploy(req, res) } else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/ai-advise', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiAdvise(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-analyze-trace', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiAnalyzeTrace(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-mapping', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiMapping(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-parse', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiParse(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-samples', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiSamples(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-extend-sample', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiExtendSample(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/schematizer', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleSchematizer(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/ai-validate', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleAiValidate(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/detect-sourcetype', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleDetectSourcetype(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/creds', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') void handleGetCreds(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/creds-test', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleTestCreds(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/creds-save', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSaveCreds(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/groups', (req: IncomingMessage, res: ServerResponse) => {
      void handleListGroups(req, res)
    })
    server.middlewares.use('/api/pack-generator/packs', (req: IncomingMessage, res: ServerResponse) => {
      void handleListPacks(req, res)
    })
    server.middlewares.use('/api/pack-generator/pack-pipelines', (req: IncomingMessage, res: ServerResponse) => {
      void handleListPackPipelines(req, res)
    })
    server.middlewares.use('/api/pack-generator/pack-pipeline', (req: IncomingMessage, res: ServerResponse) => {
      void handleGetPackPipeline(req, res)
    })
    server.middlewares.use('/api/pack-generator/workers', (req: IncomingMessage, res: ServerResponse) => {
      void handleListWorkers(req, res)
    })
    server.middlewares.use('/api/pack-generator/lake-datasets', (req: IncomingMessage, res: ServerResponse) => {
      void handleListLakeDatasets(req, res)
    })
    server.middlewares.use('/api/pack-generator/search-datasets', (req: IncomingMessage, res: ServerResponse) => {
      void handleListSearchDatasets(req, res)
    })
    server.middlewares.use('/api/pack-generator/search-datatypes', (req: IncomingMessage, res: ServerResponse) => {
      void handleListSearchDatatypes(req, res)
    })
    server.middlewares.use('/api/pack-generator/search-datatype', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleDeploySearchDatatype(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/search-dataset-datatypes', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleAttachSearchDatatypes(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/search-dashboard', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleDeploySearchDashboard(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/outputs', (req: IncomingMessage, res: ServerResponse) => {
      void handleListOutputs(req, res)
    })
    server.middlewares.use('/api/pack-generator/ensure-lake-output', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleEnsureLakeOutput(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/master-routes', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleSetMasterRoutes(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/demo-datagen', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleCreateDemoDatagen(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/demo-scan', (req: IncomingMessage, res: ServerResponse) => {
      void handleScanDemo(req, res)
    })
    server.middlewares.use('/api/pack-generator/demo-cleanup', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleCleanupDemo(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/live-capture', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleLiveCapture(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/inputs', (req: IncomingMessage, res: ServerResponse) => {
      void handleListInputs(req, res)
    })
    server.middlewares.use('/api/pack-generator/samples', (req: IncomingMessage, res: ServerResponse) => {
      void handleListSamples(req, res)
    })
    server.middlewares.use('/api/pack-generator/download-sample', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleDownloadSample(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/group-sample', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleUploadGroupSample(req, res)
      else if (req.method === 'DELETE') void handleDeleteGroupSample(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/pack-sample', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        void handleGetPackSample(req, res)
      } else if (req.method === 'POST') {
        void handleUploadPackSample(req, res)
      } else if (req.method === 'DELETE') {
        void handleDeletePackSample(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/fetch-public-samples', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleFetchPublicSamples(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/hybrid-samples', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleHybridSamples(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/debug-sample', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleDebugSample(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/validate-pipeline', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleValidatePipeline(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/repair-pipeline', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleRepairPipeline(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/pipeline-profile', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handlePipelineProfile(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/pre-deploy-validate', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handlePreDeployValidate(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    // A reused golden's verdict, written back to the record it judged (golden-trust R3).
    server.middlewares.use('/api/pack-generator/golden-observe', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') {
        void handleObserveGolden(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/golden-pipeline', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        void handleGetGolden(req, res)
      } else if (req.method === 'POST') {
        void handleSaveGolden(req, res)
      } else {
        res.statusCode = 405
        res.end('Method not allowed')
      }
    })
    server.middlewares.use('/api/pack-generator/reference-catalog', (req: IncomingMessage, res: ServerResponse) => {
      void handleReferenceCatalog(req, res)
    })
    server.middlewares.use('/api/pack-generator/reference-availability', (req: IncomingMessage, res: ServerResponse) => {
      void handleReferenceAvailability(req, res)
    })
    server.middlewares.use('/api/pack-generator/reference-sample', (req: IncomingMessage, res: ServerResponse) => {
      void handleReferenceSample(req, res)
    })
    server.middlewares.use('/api/pack-generator/reference-lookups', (req: IncomingMessage, res: ServerResponse) => {
      void handleReferenceLookups(req, res)
    })
    server.middlewares.use('/api/pack-generator/datatype-audit', (req: IncomingMessage, res: ServerResponse) => {
      void handleDatatypeAudit(req, res)
    })
    server.middlewares.use('/api/pack-generator/heal-lookup', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleHealLookup(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/log-score', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleLogScore(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/lake-health', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' || hasLegacyTokenQuery(req)) void handleLakeHealth(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/ai-health', (req: IncomingMessage, res: ServerResponse) => {
      void handleAiHealth(req, res)
    })
    server.middlewares.use('/api/pack-generator/lake-test-event', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleLakeTestEvent(req, res); else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/repair-quality', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleRepairQuality(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-available', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' || hasLegacyTokenQuery(req)) void handleGoldenAvailable(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-test', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' || hasLegacyTokenQuery(req)) void handleGoldenTest(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-import', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleGoldenImport(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-publish', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleGoldenPublish(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-reconcile', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleGoldenReconcile(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-pushable', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' || hasLegacyTokenQuery(req)) void handleGoldenPushable(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/golden-push', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleGoldenPush(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    // Sample-library review. Writes config/ai-samples/ + .cache/ai-samples-pending/ on
    // disk, so it exists in the dev server only — the iframe branch in api.ts never
    // calls these (Hard Rule 18). The promote/reject paths are POST-only: a GET that
    // mutates the committed library would be one stray prefetch away from a bad day.
    server.middlewares.use('/api/pack-generator/sample-library/promote', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSampleLibraryPromote(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sample-library/reject', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSampleLibraryReject(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    // Defer = out of the queue, nothing blacklisted, the open question kept. For the
    // sample a reviewer genuinely cannot judge yet, which otherwise had to be either
    // blacklisted on a suspicion or left in the queue to be re-read every time.
    server.middlewares.use('/api/pack-generator/sample-library/defer', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSampleLibraryDefer(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    // Discard = delete from staging WITHOUT blacklisting. For test artifacts, where a
    // permanent content blacklist would be 56 meaningless entries in rejected.json.
    server.middlewares.use('/api/pack-generator/sample-library/discard', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSampleLibraryDiscard(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sample-library', (req: IncomingMessage, res: ServerResponse) => {
      void handleSampleLibrary(req, res)
    })
    // Sanitised customer samples are a separate trust tier from AI-generated ones.
    // The installed app uses KV; these routes are the standalone disk counterpart.
    server.middlewares.use('/api/pack-generator/sanitised-samples/save', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSanitisedSampleSave(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sanitised-samples/delete', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSanitisedSampleDelete(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sanitised-samples/publish', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSanitisedSamplePublish(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sanitised-samples/test', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST') void handleSanitisedSampleTest(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
    server.middlewares.use('/api/pack-generator/sanitised-samples', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') void handleSanitisedSamples(req, res)
      else { res.statusCode = 405; res.end('Method not allowed') }
    })
  },
})

// package.json is intentionally NOT here — it's a startup-only input
// (buildNumber → `define`) handled by autoRestartPlugin via a full server
// restart. These YAML files only need a browser reload, not a restart.
const WATCHED_CONFIG_FILES = ['config/proxies.yml', 'config/policies.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      initScriptUrl = initScriptUrl || url.searchParams.get('init');
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      tags.push({
        tag: 'script',
        children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
        injectTo: 'head-prepend' as const,
      });
      if (ctx.server) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

// Auto-restart the dev server when startup-only inputs change. buildNumber
// (package.json, injected via `define`) and the backend `.mjs` handlers are
// read/bundled at config-eval time — HMR does NOT pick them up, so a change
// needs a full server restart. server.restart() re-evaluates this config
// (re-reading package.json and re-bundling the handler imports), giving the
// same effect as a fresh `npm run dev` without killing the process.
const autoRestartPlugin = () => ({
  name: 'cribl-auto-restart',
  configureServer(server: ViteDevServer) {
    const root = server.config.root;
    const pkgPath = join(root, 'package.json');
    server.watcher.add([pkgPath, join(root, 'scripts')]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const maybeRestart = (file: string) => {
      const norm = file.replace(/\\/g, '/');
      const watched = file === pkgPath || (norm.includes('/scripts/') && norm.endsWith('.mjs'));
      if (!watched) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        server.config.logger.info(`[cribl] ${norm.split('/').pop()} changed — restarting dev server…`, { timestamp: true });
        void server.restart();
      }, 150);
    };
    server.watcher.on('change', maybeRestart);
    server.watcher.on('add', maybeRestart);
  },
});

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { buildNumber?: number; version?: string };

// Emit a tiny version.json next to the static bundle, and serve it in dev, so a
// running tab can detect when the DEPLOYED build is newer than the one it
// loaded and offer a reload (see UpdateBanner in App.tsx). `base: './'` means
// the app fetches it relative to wherever the host serves the app — works in
// both iframe (Cribl) and standalone.
const readFresh = () => JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { buildNumber?: number; version?: string };
const versionEndpointPlugin = () => ({
  name: 'version-endpoint',
  // Build: write dist/version.json into the bundle (re-read package.json so a
  // freshly-bumped buildNumber is reflected).
  generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
    const fresh = readFresh();
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: fresh.buildNumber || 0, version: fresh.version || '0.0.0' }) });
  },
  // Dev: serve /version.json from the live package.json (reflects restarts).
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/version.json', (_req: IncomingMessage, res: ServerResponse) => {
      const fresh = readFresh();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ build: fresh.buildNumber || 0, version: fresh.version || '0.0.0' }));
    });
  },
});

// Compute the set of src/* modules STATICALLY reachable from the Sample Sanitizer
// entry, so codeSplitting can pin exactly those into the eager `sanitizer-core` chunk.
// We deliberately follow ONLY static `from '...'` / bare-side-effect imports and NOT
// dynamic `import(...)`: a dynamically-imported module (e.g. sample-io's lazy
// `import('./bundled-data')`, which pulls source-samples + the xsiam catalogs) must stay
// in its OWN lazy chunk, not be dragged eager into sanitizer-core. Following dynamic
// edges here is what previously baked ~1 MB of pack-generation JSON into the initial
// sanitizer bundle. AI-freeness is asserted separately by tests/sanitizer-ai-free-test.mjs
// (which DOES follow dynamic edges, for reachability) — this walker only steers chunking,
// and a lazy AI-free module never matches the ai-core group's ai-client/ai-budget test.
function sanitizerReachableModules(): Set<string> {
  const root = resolve(process.cwd(), 'src');
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try { src = readFileSync(file, 'utf8'); } catch { return; }
    const specs: string[] = [];
    for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
        try { readFileSync(c); walk(c); break; } catch { /* try next candidate */ }
      }
    }
  };
  walk(resolve(root, 'sanitizer-main.tsx'));
  return seen;
}
const SANITIZER_MODULES = sanitizerReachableModules();

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), corsProxyPlugin(), deployApiPlugin(), injectScriptFromQueryPlugin(), autoRestartPlugin(), versionEndpointPlugin()],
  base: './',
  define: {
    BUILD_NUMBER: JSON.stringify(pkg.buildNumber || 0),
    APP_VERSION: JSON.stringify(pkg.version || '0.0.0'),
  },
  server: {
    // Bind IPv4 + IPv6. Default Vite can end up on [::1] only, which breaks
    // browsers/tools that resolve localhost → 127.0.0.1.
    host: true,
    cors: true,
    watch: {
      // Do NOT restart the dev server when .env changes. Saving a credential
      // (golden/lake/AI token) POSTs /creds-save, which upserts .env — and
      // Vite's built-in dotenv watcher would then tear the server down and
      // back up. The Settings "Test" button saves the token and IMMEDIATELY
      // fetches /golden-test, so that follow-up call hit a server mid-restart
      // and failed with a bare "Failed to fetch". The restart is unnecessary:
      // handleSaveCreds already applies the value to process.env in-memory
      // (cribl-auth.mjs), and golden-github.mjs reads process.env at call time,
      // so the new token is live without a bounce. (Handler code — scripts/*.mjs
      // and package.json — still restarts via autoRestartPlugin, which does not
      // watch .env.)
      ignored: ['**/.env', '**/.env.*'],
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    assetsInlineLimit: 20000,
    rollupOptions: {
      // Two app entries from one build: the pack generator (index.html) and the
      // standalone Sample Sanitizer (sanitizer.html). They share chunked assets;
      // scripts/pkgutil.mjs picks the right HTML entry per app pack.
      input: {
        main: join(process.cwd(), 'index.html'),
        sanitizer: join(process.cwd(), 'sanitizer.html'),
      },
      output: {
        // Deterministic chunk grouping (rolldown `codeSplitting.groups`, priority-ordered
        // first-match). We do NOT use a `manualChunks` function: rolldown wraps that as a
        // SINGLE group and then re-homes shared modules by its own sharing heuristic, which
        // dragged golden-formats.json (and, through it, the sanitiser's whole reachable set)
        // into the ai-core-anchored chunk even though manualChunks returned 'sanitizer-core'.
        // Explicit groups with priority claim a shared module for the higher-priority group.
        codeSplitting: {
          groups: [
            {
              name: 'bundled-config',
              priority: 30,
              test: (id: string) =>
                /config\/(reference-catalog|golden-lookups)/.test(id),
            },
            {
              // Every module the Sample Sanitizer statically reaches (src code + the JSON
              // data it imports), claimed at HIGHER priority than ai-core so a module shared
              // with the pack generator (golden-formats.json, pack-builder, …) lands HERE and
              // the sanitizer entry never has to import the ai-core chunk to reach it. .css is
              // an asset, left to the asset pipeline. AI-freeness of this set is a source-graph
              // fact asserted by tests/sanitizer-ai-free-test.mjs — this only steers chunking.
              name: 'sanitizer-core',
              priority: 20,
              test: (id: string) => {
                // The NUL is deliberate and load-bearing: rollup prefixes VIRTUAL module
                // ids with \0, so stripping it is how a virtual id is matched against the
                // real module paths in SANITIZER_MODULES. Not a stray control character.
                // eslint-disable-next-line no-control-regex
                const clean = id.replace(/^\0/, '').split('?')[0];
                return SANITIZER_MODULES.has(clean) && !clean.endsWith('.css');
              },
            },
            {
              // The ONLY chunk carrying executable AI code (provider clients + budget policy;
              // the schematizer lives inside ai-client). Lower priority than sanitizer-core so
              // a sanitiser-shared module is never pulled in here. NOTE: ai-samples.ts is NOT
              // matched — despite the name it is a pure data module (sourcetype catalog +
              // curated fallback samples, zero imports) used by the sanitiser's sample tier.
              name: 'ai-core',
              priority: 10,
              test: (id: string) => /\/src\/(ai-client|ai-budget)\.[jt]sx?$/.test(id),
            },
          ],
        },
      },
    },
  }
})
