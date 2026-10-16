import { useState, useEffect } from 'react';
import { loadSettingsAsync, saveSettings, testAiConnection, testBackendProxy } from './ai-client';
import type { AiProvider } from './ai-client';
import { invalidateAiHealth } from './api';
import { getRunMode } from './run-mode';
import { aiSettingsLocked } from './settings-store';

const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

const BEDROCK_MODELS = [
  { id: 'us.anthropic.claude-opus-5', label: 'Claude Opus 5 (Bedrock)' },
  { id: 'us.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8 (Bedrock)' },
  { id: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7 (Bedrock)' },
  { id: 'us.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5 (Bedrock)' },
  { id: 'us.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5 (Bedrock)' },
  { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4 (Bedrock)' },
  { id: 'us.anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5 (Bedrock)' },
];

const OPENAI_MODELS = [
  { id: 'gpt-4.1', label: 'GPT-4.1' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { id: 'o4-mini', label: 'o4-mini' },
  { id: 'gpt-4o', label: 'GPT-4o' },
];

const MISTRAL_MODELS = [
  { id: 'mistral-large-latest', label: 'Mistral Large' },
  { id: 'mistral-small-latest', label: 'Mistral Small' },
  { id: 'codestral-latest', label: 'Codestral' },
];

const AZUREAI_MODELS = [
  { id: 'gpt-4.1', label: 'GPT-4.1 (GitHub Copilot)' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (GitHub Copilot)' },
  { id: 'o4-mini', label: 'o4-mini (GitHub Copilot)' },
  { id: 'gpt-4o', label: 'GPT-4o (GitHub Copilot)' },
];

const GEMINI_MODELS = [
  { id: 'gemini-pro-latest', label: 'Gemini Pro (Best quality)' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (Fast)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (Cheapest)' },
];

const DEV_PROXY_MODELS = [
  { id: 'us.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'us.anthropic.claude-opus-5', label: 'Claude Opus 5' },
  { id: 'us.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'us.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5' },
  { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4' },
  { id: 'anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'anthropic.claude-fable-5', label: 'Claude Fable 5' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro' },
  { id: 'qwen.qwen3-coder-next', label: 'Qwen3 Coder Next' },
  { id: 'moonshotai/Kimi-K3', label: 'Kimi K3' },
  { id: 'moonshotai.kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'zai-org/GLM-5.2', label: 'GLM 5.2' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B', label: 'Nemotron 3 Ultra 550B' },
  { id: 'thinkingmachines/inkling-small', label: 'Inkling Small' },
];

// The org's AI Settings choose the model; this id only labels the choice.
const CRIBL_AI_MODELS = [
  { id: 'cribl-ai-settings', label: "Set by the org's AI Settings" },
];

const BEDROCK_REGIONS = [
  'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1',
  'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2',
];

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'devproxy', label: 'Cribl AI (Aperture)' },
  { id: 'cribl', label: 'Cribl AI Settings (this org)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'bedrock', label: 'AWS Bedrock' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'azureai', label: 'Azure AI / Copilot' },
  { id: 'gemini', label: 'Google Gemini' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rendered inside the Settings page instead of as a pop-up: Save stays on the page. */
  embedded?: boolean;
  /** Called after a successful save — the header's AI probe re-runs on it. */
  onSaved?: () => void;
}

function getModels(provider: AiProvider) {
  switch (provider) {
    case 'anthropic': return ANTHROPIC_MODELS;
    case 'bedrock': return BEDROCK_MODELS;
    case 'openai': return OPENAI_MODELS;
    case 'mistral': return MISTRAL_MODELS;
    case 'azureai': return AZUREAI_MODELS;
    case 'gemini': return GEMINI_MODELS;
    case 'cribl': return CRIBL_AI_MODELS;
    default: return DEV_PROXY_MODELS;
  }
}

export default function AiSettingsModal({ open, onClose, embedded, onSaved }: Props) {
  const [provider, setProvider] = useState<AiProvider>(getRunMode() === 'iframe' ? 'anthropic' : 'devproxy');
  const [model, setModel] = useState('');
  const [normalModel, setNormalModel] = useState('');
  const [repairModel, setRepairModel] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [bedrockRegion, setBedrockRegion] = useState('us-east-1');
  const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState('');
  const [bedrockSecretAccessKey, setBedrockSecretAccessKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [mistralApiKey, setMistralApiKey] = useState('');
  const [azureaiApiKey, setAzureaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [devProxyUrl, setDevProxyUrl] = useState('http://ai-gateway.example/bedrock');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    if (open) {
      loadSettingsAsync().then(s => {
        setProvider(s.provider);
        setModel(s.model);
        setNormalModel(s.normalModel || s.model);
        setRepairModel(s.repairModel || s.model);
        setAnthropicApiKey(s.anthropicApiKey || '');
        setBedrockRegion(s.bedrockRegion || 'us-east-1');
        setBedrockAccessKeyId(s.bedrockAccessKeyId || '');
        setBedrockSecretAccessKey(s.bedrockSecretAccessKey || '');
        setOpenaiApiKey(s.openaiApiKey || '');
        setMistralApiKey(s.mistralApiKey || '');
        setAzureaiApiKey(s.azureaiApiKey || '');
        setGeminiApiKey(s.geminiApiKey || '');
        setDevProxyUrl(s.devProxyUrl || 'http://ai-gateway.example/bedrock');
        setTestStatus('idle');
        setTestMessage('');
      });
    }
  }, [open]);

  if (!open) return null;

  const locked = aiSettingsLocked();

  const handleProviderChange = (p: AiProvider) => {
    setProvider(p);
    const defaultModel = getModels(p)[0].id;
    setModel(defaultModel);
    setNormalModel(defaultModel);
    setRepairModel(defaultModel);
  };

  const handleSave = async () => {
    setTestStatus('testing');
    setTestMessage('Saving credentials…');
    try {
      await saveSettings({
        provider, model, normalModel, repairModel, anthropicApiKey,
        bedrockRegion, bedrockAccessKeyId, bedrockSecretAccessKey,
        openaiApiKey, mistralApiKey, azureaiApiKey, geminiApiKey, devProxyUrl,
      });
      // The cached health result is keyed on provider/endpoint/model, so a changed API key
      // alone would otherwise keep serving the old verdict to the header.
      invalidateAiHealth();
      onSaved?.();
      if (embedded) { setTestStatus('success'); setTestMessage('Saved.'); } else onClose();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Credential save failed.');
    }
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    // Save current settings first so the test uses them. A locked install has
    // nothing to save: it always tests the org's AI Settings.
    if (!locked) try {
      await saveSettings({
        provider, model, normalModel, repairModel, anthropicApiKey,
        bedrockRegion, bedrockAccessKeyId, bedrockSecretAccessKey,
        openaiApiKey, mistralApiKey, azureaiApiKey, geminiApiKey, devProxyUrl,
      });
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Credential save failed.');
      return;
    }
    invalidateAiHealth();
    const result = provider === 'devproxy'
      ? await testBackendProxy()
      : await testAiConnection();
    setTestStatus(result.ok ? 'success' : 'error');
    setTestMessage(result.message);
  };

  const models = getModels(provider);

  return (
    <div className={embedded ? 'tp-embed' : 'modal-backdrop'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'tp-embed-panel' : 'modal-panel'} onClick={e => e.stopPropagation()}>
        {!embedded && (
        <div className="modal-header">
          <h3>AI Settings</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        )}

        <div className="modal-body">
          {locked ? (
            <p className="field-hint" style={{ margin: '0 0 12px', color: '#595959' }}>
              Inside Cribl, Pack Generator uses this org's AI Settings. To change the provider or model, ask a Cribl admin to update Settings → AI Settings. These settings can only be changed when the app runs on localhost.
            </p>
          ) : getRunMode() === 'iframe' && (
            <p className="field-hint" style={{ margin: '0 0 12px', color: '#595959' }}>
              Choose Cribl AI Settings to use this org's own AI provider, or configure an API key for one of the other providers.
            </p>
          )}
          <div className="field-group">
            <label className="field-label">Provider</label>
            <select className="field-select" value={provider} disabled={locked} onChange={e => handleProviderChange(e.target.value as AiProvider)}>
              {/* Aperture needs Tailscale (standalone only); Cribl AI Settings needs the Cribl UI session (App only). */}
              {PROVIDERS.filter(p => getRunMode() === 'iframe' ? p.id !== 'devproxy' : p.id !== 'cribl').map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>

          {provider === 'devproxy' && (
            <div className="field-group">
              <label className="field-label">Proxy URL</label>
              <input
                className="field-input"
                type="text"
                placeholder="http://ai-gateway.example/bedrock"
                value={devProxyUrl}
                onChange={e => setDevProxyUrl(e.target.value)}
              />
              <p className="field-hint">
                Internal Cribl AI via Aperture (Tailscale). No credentials needed — the proxy handles auth. Requires Tailscale connection and #proj-ts-aperture-enablement access.
              </p>
            </div>
          )}

          {provider === 'cribl' && !locked && (
            <div className="field-group">
              <p className="field-hint">
                Uses the provider and model configured for this org in Settings → AI Settings (bring-your-own-model or Cribl-managed). No API key needed here.
              </p>
            </div>
          )}

          {provider === 'anthropic' && (
            <div className="field-group">
              <label className="field-label">API Key</label>
              <input
                className="field-input"
                type="password"
                placeholder="sk-ant-api03-..."
                value={anthropicApiKey}
                onChange={e => setAnthropicApiKey(e.target.value)}
              />
              <p className="field-hint">
                Stored encrypted in KV — the Cribl proxy injects it on each request. Only needs to be entered once.
              </p>
            </div>
          )}

          {provider === 'bedrock' && (
            <>
              <div className="field-group">
                <label className="field-label">AWS Region</label>
                <select className="field-select" value={bedrockRegion} onChange={e => setBedrockRegion(e.target.value)}>
                  {BEDROCK_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">Access Key ID</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="AKIA..."
                  value={bedrockAccessKeyId}
                  onChange={e => setBedrockAccessKeyId(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label className="field-label">Secret Access Key</label>
                <input
                  className="field-input"
                  type="password"
                  placeholder="wJa..."
                  value={bedrockSecretAccessKey}
                  onChange={e => setBedrockSecretAccessKey(e.target.value)}
                />
                <p className="field-hint">
                  IAM user needs <code>bedrock:InvokeModel</code> permission.
                </p>
              </div>
            </>
          )}

          {provider === 'openai' && (
            <div className="field-group">
              <label className="field-label">API Key</label>
              <input
                className="field-input"
                type="password"
                placeholder="sk-..."
                value={openaiApiKey}
                onChange={e => setOpenaiApiKey(e.target.value)}
              />
              <p className="field-hint">
                Get a key at <code>platform.openai.com</code>
              </p>
            </div>
          )}

          {provider === 'mistral' && (
            <div className="field-group">
              <label className="field-label">API Key</label>
              <input
                className="field-input"
                type="password"
                placeholder="..."
                value={mistralApiKey}
                onChange={e => setMistralApiKey(e.target.value)}
              />
              <p className="field-hint">
                Get a key at <code>console.mistral.ai</code>
              </p>
            </div>
          )}

          {provider === 'azureai' && (
            <div className="field-group">
              <label className="field-label">API Key / Token</label>
              <input
                className="field-input"
                type="password"
                placeholder="ghp_... or Azure token"
                value={azureaiApiKey}
                onChange={e => setAzureaiApiKey(e.target.value)}
              />
              <p className="field-hint">
                GitHub Copilot token or Azure AI inference key. Uses <code>models.inference.ai.azure.com</code>.
              </p>
            </div>
          )}

          {provider === 'gemini' && (
            <div className="field-group">
              <label className="field-label">API Key</label>
              <input
                className="field-input"
                type="password"
                placeholder="AIza..."
                value={geminiApiKey}
                onChange={e => setGeminiApiKey(e.target.value)}
              />
              <p className="field-hint">
                Google AI Studio API key (<code>aistudio.google.com/apikey</code>). Uses <code>generativelanguage.googleapis.com</code>.
              </p>
            </div>
          )}

          {provider !== 'cribl' && (<>
          <div style={{ borderTop: '1px solid #e8e8e8', margin: '16px 0 8px' }} />
          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Model Selection</p>

          <div className="field-group">
            <label className="field-label">Default model</label>
            <select className="field-select" value={model} onChange={e => setModel(e.target.value)}>
              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">Normal-flow model</label>
            <select className="field-select" value={normalModel} onChange={e => setNormalModel(e.target.value)}>
              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <p className="field-hint">Model for initial pack generation (parse + mapping).</p>
          </div>

          <div className="field-group">
            <label className="field-label">Repair-flow model</label>
            <select className="field-select" value={repairModel} onChange={e => setRepairModel(e.target.value)}>
              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <p className="field-hint">Model for post-deploy quality repair (second opinion).</p>
          </div>
          </>)}
        </div>

        {testMessage && (
          <div className="test-result" style={{
            padding: '8px 20px',
            fontSize: 12,
            background: testStatus === 'success' ? '#f6ffed' : testStatus === 'error' ? '#fff2f0' : '#f5f5f5',
            color: testStatus === 'success' ? '#389e0d' : testStatus === 'error' ? '#cf1322' : '#595959',
            borderTop: '1px solid #f0f0f0',
          }}>
            {testStatus === 'success' ? '✓ ' : testStatus === 'error' ? '✗ ' : ''}{testMessage}
          </div>
        )}
        <div className="modal-footer">
          <button
            className="btn-secondary"
            onClick={handleTest}
            disabled={testStatus === 'testing'}
          >
            {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
          </button>
          <div style={{ flex: 1 }} />
          {!embedded && <button className="btn-secondary" onClick={onClose}>Cancel</button>}
          {!locked && <button className="btn-primary" onClick={handleSave}>Save</button>}
        </div>
      </div>
    </div>
  );
}
