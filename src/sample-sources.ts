export interface SampleSource {
  id: string;
  label: string;
  description: string;
  icon: string;
  type: 'builtin' | 'public' | 'ai' | 'hybrid';
  url?: string;
  repo?: string;
  format?: string;
  eventCount?: string;
}

const BUILTIN_SOURCE: SampleSource = {
  id: 'built-in',
  label: 'Built-in sample',
  description: 'Vendor-format events generated locally from the built-in template — no AI or network required',
  icon: '\u{1F4E6}',
  type: 'builtin',
  eventCount: '100',
};

const PUBLIC_SOURCES: Record<string, SampleSource[]> = {
  windows_security: [
    {
      id: 'evtx-attack-samples',
      label: 'EVTX-ATTACK-SAMPLES',
      description: '200+ Windows Security events mapped to MITRE ATT&CK techniques (GitHub)',
      icon: '\u{1F6E1}',
      type: 'public',
      repo: 'sbousseaden/EVTX-ATTACK-SAMPLES',
      url: 'https://raw.githubusercontent.com/sbousseaden/EVTX-ATTACK-SAMPLES/master/compiled_samples/windows_security_sample.json',
      format: 'json',
      eventCount: '200+',
    },
    {
      id: 'loghub-windows',
      label: 'Loghub Windows Dataset',
      description: 'Large-scale Windows event log dataset for analytics research (Zenodo/GitHub)',
      icon: '\u{1F4DA}',
      type: 'public',
      repo: 'logpai/loghub',
      url: 'https://raw.githubusercontent.com/logpai/loghub/master/Windows/Windows_2k.log',
      format: 'text',
      eventCount: '2,000',
    },
  ],
  windows_powershell: [
    {
      id: 'evtx-attack-powershell',
      label: 'EVTX-ATTACK-SAMPLES (PowerShell)',
      description: 'PowerShell script block events with suspicious patterns — MITRE ATT&CK mapped',
      icon: '\u{1F6E1}',
      type: 'public',
      repo: 'sbousseaden/EVTX-ATTACK-SAMPLES',
      url: 'https://raw.githubusercontent.com/sbousseaden/EVTX-ATTACK-SAMPLES/master/compiled_samples/windows_powershell_sample.json',
      format: 'json',
      eventCount: '100+',
    },
  ],
  windows_sysmon: [
    {
      id: 'evtx-attack-sysmon',
      label: 'EVTX-ATTACK-SAMPLES (Sysmon)',
      description: 'Sysmon events with process creation, network, registry — MITRE technique tagged',
      icon: '\u{1F6E1}',
      type: 'public',
      repo: 'sbousseaden/EVTX-ATTACK-SAMPLES',
      url: 'https://raw.githubusercontent.com/sbousseaden/EVTX-ATTACK-SAMPLES/master/compiled_samples/windows_sysmon_sample.json',
      format: 'json',
      eventCount: '150+',
    },
  ],
  aws_cloudtrail: [
    {
      id: 'cloudtrail-threat-detector',
      label: 'CloudTrail Threat Samples',
      description: 'Simulated CloudTrail events including security-relevant API calls (GitHub)',
      icon: '\u{2601}',
      type: 'public',
      repo: 'Grishmbasnet515/ai-cloud-log-threat-detector',
      url: 'https://raw.githubusercontent.com/Grishmbasnet515/ai-cloud-log-threat-detector/main/sample_logs/cloudtrail_sample.json',
      format: 'json',
      eventCount: '50+',
    },
  ],
  okta_system: [
    {
      id: 'okta-sample-logs',
      label: 'Okta System Log Samples',
      description: 'Okta System Log API response examples — auth, MFA, SSO events',
      icon: '\u{1F511}',
      type: 'public',
      repo: 'kaus33k/okta-sample-system-logs',
      url: 'https://raw.githubusercontent.com/kaus33k/okta-sample-system-logs/main/sample_events.json',
      format: 'json',
      eventCount: '30+',
    },
  ],
  linux_syslog: [
    {
      id: 'loghub-linux',
      label: 'Loghub Linux Dataset',
      description: 'Linux syslog messages — sshd, cron, systemd, auth events (GitHub)',
      icon: '\u{1F427}',
      type: 'public',
      repo: 'logpai/loghub',
      url: 'https://raw.githubusercontent.com/logpai/loghub/master/Linux/Linux_2k.log',
      format: 'text',
      eventCount: '2,000',
    },
  ],
  apache_access: [
    {
      id: 'loghub-apache',
      label: 'Loghub Apache Dataset',
      description: 'Apache HTTPD access logs in Combined Log Format (GitHub)',
      icon: '\u{1F310}',
      type: 'public',
      repo: 'logpai/loghub',
      url: 'https://raw.githubusercontent.com/logpai/loghub/master/Apache/Apache_2k.log',
      format: 'text',
      eventCount: '2,000',
    },
  ],
};

const AI_SOURCE: SampleSource = {
  id: 'ai-generate',
  label: 'AI-Generated',
  description: 'Generate fresh synthetic events using AI — customizable count and diversity',
  icon: '\u{1F916}',
  type: 'ai',
};

const HYBRID_SOURCE: SampleSource = {
  id: 'hybrid',
  label: 'Hybrid (Public + AI)',
  description: 'Fetch real samples as seed, then AI generates more with matching format and diversity',
  icon: '\u{2728}',
  type: 'hybrid',
};

export function getAvailableSources(sourcetype: string, hasBuiltIn = false): SampleSource[] {
  const publicSources = PUBLIC_SOURCES[sourcetype] || [];
  const sources: SampleSource[] = [];

  if (publicSources.length > 0) {
    sources.push(HYBRID_SOURCE);
    sources.push(...publicSources);
  }
  if (hasBuiltIn) sources.push(BUILTIN_SOURCE);
  sources.push(AI_SOURCE);

  return sources;
}

export function getPublicSource(sourcetype: string, sourceId: string): SampleSource | undefined {
  const all = PUBLIC_SOURCES[sourcetype] || [];
  return all.find(s => s.id === sourceId);
}
