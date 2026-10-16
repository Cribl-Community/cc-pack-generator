export interface Sourcetype {
  value: string;
  label: string;
  category: string;
}

export const SOURCETYPES: Sourcetype[] = [
  { value: 'cisco_asa', label: 'Cisco ASA', category: 'Network Security' },
  { value: 'cisco_firepower', label: 'Cisco Firepower', category: 'Network Security' },
  { value: 'cisco_ftd', label: 'Cisco FTD (Firepower Threat Defense)', category: 'Network Security' },
  { value: 'cisco_esa', label: 'Cisco ESA (Email Security)', category: 'Email Security' },
  { value: 'palo_alto_traffic', label: 'Palo Alto Traffic', category: 'Network Security' },
  { value: 'palo_alto_threat', label: 'Palo Alto Threat', category: 'Network Security' },
  { value: 'fortinet_fortigate', label: 'Fortinet FortiGate', category: 'Network Security' },
  { value: 'checkpoint_firewall', label: 'Check Point Firewall', category: 'Network Security' },
  { value: 'windows_powershell', label: 'Windows PowerShell', category: 'Endpoint' },
  { value: 'windows_security', label: 'Windows Security', category: 'Endpoint' },
  { value: 'windows_sysmon', label: 'Windows Sysmon', category: 'Endpoint' },
  { value: 'linux_syslog', label: 'Linux Syslog', category: 'Endpoint' },
  { value: 'linux_audit', label: 'Linux Auditd', category: 'Endpoint' },
  { value: 'crowdstrike_falcon', label: 'CrowdStrike Falcon', category: 'Endpoint' },
  { value: 'aws_cloudtrail', label: 'AWS CloudTrail', category: 'Cloud' },
  { value: 'alibaba_action_trail', label: 'Alibaba Cloud ActionTrail', category: 'Cloud' },
  { value: 'aws_vpc_flow', label: 'AWS VPC Flow Logs', category: 'Cloud' },
  { value: 'azure_signin', label: 'Azure AD Sign-in', category: 'Cloud' },
  { value: 'gcp_audit', label: 'GCP Audit Log', category: 'Cloud' },
  { value: 'okta_system', label: 'Okta System Log', category: 'Identity' },
  { value: 'zscaler_web', label: 'Zscaler Web', category: 'Proxy' },
  { value: 'apache_access', label: 'Apache Access Log', category: 'Web' },
  { value: 'nginx_access', label: 'Nginx Access Log', category: 'Web' },
  { value: '__custom__', label: 'Custom / Other', category: 'Other' },
];

function randomIp(): string {
  return `10.${r(255)}.${r(255)}.${r(255)}`;
}

function publicIp(): string {
  return `${r(200) + 20}.${r(255)}.${r(255)}.${r(255)}`;
}

function r(max: number): number {
  return Math.floor(Math.random() * max);
}

function ts(): string {
  return new Date(Date.now() - r(86400000)).toISOString();
}

function syslogTs(): string {
  const d = new Date(Date.now() - r(86400000));
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2,' ')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

const USERS = ['admin', 'jdoe', 'svc-app', 'msmith', 'operator', 'deploy', 'kbrown', 'analyst'];
const HOSTS = ['fw-01', 'fw-02', 'dc-01', 'web-01', 'app-02', 'db-03', 'proxy-01', 'edge-01'];

const generators: Record<string, () => string[]> = {
  cisco_asa: () => gen(100, (i) => {
    const actions = ['Built', 'Teardown', 'Deny', 'Permitted'];
    const protocols = ['TCP', 'UDP', 'ICMP'];
    const action = actions[r(actions.length)];
    const proto = protocols[r(protocols.length)];
    return `${syslogTs()} fw-0${r(2)+1} %ASA-6-${302013 + r(10)}: ${action} inbound ${proto} connection ${100000+i} for outside:${publicIp()}/${1024+r(60000)} (${publicIp()}/${1024+r(60000)}) to inside:${randomIp()}/${r(1024)+1} (${randomIp()}/${r(1024)+1})`;
  }),

  cisco_firepower: () => gen(100, (i) => {
    const actions = ['Allow', 'Block', 'Monitor'];
    const rules = ['AC_Rule_Web', 'AC_Rule_DNS', 'Default_Action', 'Intrusion_Block'];
    return `${syslogTs()} fmc-01 SFIMS: Protocol: TCP, SrcIP: ${publicIp()}, DstIP: ${randomIp()}, SrcPort: ${1024+r(60000)}, DstPort: ${[80,443,8080,22,3389][r(5)]}, Policy: Default, AccessControlRuleName: ${rules[r(rules.length)]}, AccessControlRuleAction: ${actions[r(actions.length)]}, UserAgent: Mozilla/5.0, URL: https://example${r(100)}.com/path${i}`;
  }),

  cisco_esa: () => {
    // Cisco ESA mail_logs: realistic multi-line-per-message sequences flattened
    // into individual log lines (one message = several correlated lines).
    const domains = ['example.com', 'company.com', 'partner.org', 'marketing-updates.net'];
    const users = ['jsmith', 'awong', 'mgarcia', 'newsletter', 'billing'];
    const esaTs = () => {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];
      const d = r(28) + 1;
      return `${days[r(5)]} ${months[r(5)]} ${d < 10 ? ' ' + d : d} ${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')} 2024`;
    };
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const mid = 8800 + i;
      const icid = 4400 + i;
      const sender = `${users[r(users.length)]}@${domains[r(domains.length)]}`;
      const rcpt = `${users[r(users.length)]}@company.com`;
      const spam = ['negative', 'positive', 'suspect'][r(3)];
      lines.push(`${esaTs()} Info: New SMTP ICID ${icid} interface Management (10.1.1.1) address ${publicIp()} reverse dns host mail${r(50)}.${domains[r(domains.length)]} verified ${['yes','no'][r(2)]}`);
      lines.push(`${esaTs()} Info: Start MID ${mid} ICID ${icid}`);
      lines.push(`${esaTs()} Info: MID ${mid} ICID ${icid} From: <${sender}>`);
      lines.push(`${esaTs()} Info: MID ${mid} ICID ${icid} RID 0 To: <${rcpt}>`);
      lines.push(`${esaTs()} Info: MID ${mid} Subject 'Quarterly report ${i}'`);
      lines.push(`${esaTs()} Info: MID ${mid} ready ${5000 + r(50000)} bytes from <${sender}>`);
      lines.push(`${esaTs()} Info: MID ${mid} interim verdict using engine: CASE spam ${spam}`);
      if (r(5) === 0) {
        lines.push(`${esaTs()} Warning: MID ${mid} antivirus positive 'Trojan.Generic.${r(9999)}'`);
        lines.push(`${esaTs()} Info: Message aborted MID ${mid} Dropped by antivirus`);
      } else if (spam === 'positive') {
        lines.push(`${esaTs()} Info: EUQ: Quarantined MID ${mid}`);
      } else {
        lines.push(`${esaTs()} Info: MID ${mid} queued for delivery`);
        lines.push(`${esaTs()} Info: Message finished MID ${mid} done`);
      }
      lines.push(`${esaTs()} Info: ICID ${icid} close`);
    }
    return lines;
  },

  palo_alto_traffic: () => gen(100, () => {
    const actions = ['allow', 'deny', 'drop', 'reset-both'];
    const apps = ['web-browsing', 'ssl', 'dns', 'ms-office365', 'smtp', 'ssh', 'rdp'];
    const zones = ['trust', 'untrust', 'dmz'];
    return `1,2024/01/15 ${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')},001234567890,TRAFFIC,end,2816,2024/01/15 ${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')},${randomIp()},${publicIp()},0.0.0.0,0.0.0.0,Allow-All,,,${apps[r(apps.length)]},vsys1,${zones[r(zones.length)]},${zones[r(zones.length)]},ethernet1/1,ethernet1/2,Log-Forwarding,${Date.now()},${r(90000)},${1024+r(60000)},${[80,443,8080,22][r(4)]},0,0,0x400000,tcp,${actions[r(actions.length)]},${r(50000)},${r(5000)},${r(50000)},${r(100)},${syslogTs()},0,any,0,${r(999999999)},0x0,10.0.0.0-10.255.255.255,US,0,${r(50)},${r(50)},aging-out,0,0,0,0,,PA-5220,from-policy`;
  }),

  palo_alto_threat: () => gen(100, () => {
    const threats = ['spyware', 'vulnerability', 'virus', 'wildfire', 'url-filtering'];
    const severities = ['critical', 'high', 'medium', 'low', 'informational'];
    const actions = ['alert', 'drop', 'reset-both', 'block-url'];
    return `1,2024/01/15 ${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')},001234567890,THREAT,${threats[r(threats.length)]},2816,2024/01/15 ${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')},${randomIp()},${publicIp()},0.0.0.0,0.0.0.0,Threat-Rule,,,web-browsing,vsys1,trust,untrust,ethernet1/1,ethernet1/2,Log-Forwarding,${Date.now()},${r(90000)},${1024+r(60000)},443,0,0,0x400000,tcp,${actions[r(actions.length)]},"Suspicious.Gen/Trojan(${30000+r(10000)})",${30000+r(10000)},any,${severities[r(severities.length)]},client-to-server,${r(9999999)},0x0,10.0.0.0-10.255.255.255,US,0,,0,,,,,,,,0,0,0,0,0,,PA-5220,`;
  }),

  fortinet_fortigate: () => gen(100, () => {
    const actions = ['accept', 'deny', 'close', 'timeout'];
    const services = ['HTTPS', 'HTTP', 'DNS', 'SSH', 'SMTP', 'RDP'];
    return `date=${new Date(Date.now()-r(86400000)).toISOString().split('T')[0]} time=${String(r(24)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')}:${String(r(60)).padStart(2,'0')} devname="FGT-01" devid="FG100E0000000001" logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" eventtime=${Math.floor(Date.now()/1000)} srcip=${randomIp()} srcport=${1024+r(60000)} srcintf="port1" dstip=${publicIp()} dstport=${[80,443,53,22,25][r(5)]} dstintf="port2" policyid=${r(50)+1} sessionid=${r(9999999)} proto=6 action="${actions[r(actions.length)]}" service="${services[r(services.length)]}" duration=${r(3600)} sentbyte=${r(500000)} rcvdbyte=${r(500000)} sentpkt=${r(1000)} rcvdpkt=${r(1000)} user="${USERS[r(USERS.length)]}" appcat="unscanned"`;
  }),

  checkpoint_firewall: () => gen(100, () => {
    const actions = ['Accept', 'Drop', 'Reject', 'Log'];
    const protos = ['tcp', 'udp', 'icmp'];
    return `${syslogTs()} gw-01 product="VPN-1 & FireWall-1" action="${actions[r(actions.length)]}" orig=gw-01 src=${randomIp()} dst=${publicIp()} proto="${protos[r(protos.length)]}" s_port="${1024+r(60000)}" service="${[80,443,22,53,8443][r(5)]}" rule="${r(30)+1}" xlatesrc=${randomIp()} xlatedst=${publicIp()} user="${USERS[r(USERS.length)]}" bytes="${r(500000)}"`;
  }),

  windows_powershell: () => gen(100, (i) => {
    const commands = ['Get-Process', 'Set-ExecutionPolicy', 'Invoke-WebRequest', 'New-Object', 'Get-ADUser', 'Start-Service', 'Get-EventLog', 'Import-Module', 'Invoke-Expression', 'Get-WmiObject'];
    const scriptBlocks = ['$client = New-Object System.Net.WebClient', '$env:COMPUTERNAME', 'Get-ChildItem -Recurse', '[System.IO.File]::ReadAllText($path)', 'ConvertTo-SecureString'];
    const cmd = commands[r(commands.length)];
    const host = HOSTS[r(HOSTS.length)];
    const user = USERS[r(USERS.length)];
    return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{A0C1853B-5C40-4B15-8766-3CF1C58F985A}'/><EventID>${[4103,4104,4105,4106][r(4)]}</EventID><Level>${[3,4,5][r(3)]}</Level><Computer>${host}.corp.local</Computer><TimeCreated SystemTime='${ts()}'/><Security UserID='S-1-5-21-${r(999999999)}-${r(999999999)}-${r(999999999)}-${1000+r(5000)}'/></System><EventData><Data Name='MessageNumber'>${i+1}</Data><Data Name='MessageTotal'>1</Data><Data Name='ScriptBlockText'>${scriptBlocks[r(scriptBlocks.length)]}</Data><Data Name='ScriptBlockId'>${crypto.randomUUID?.() || `${r(99999999)}-${r(9999)}-${r(9999)}-${r(9999)}-${r(999999999999)}`}</Data><Data Name='Path'>C:\\Scripts\\${cmd}.ps1</Data><Data Name='HostName'>ConsoleHost</Data><Data Name='CommandLine'>${cmd} -Name test${r(100)}</Data><Data Name='User'>${user}</Data></EventData></Event>`;
  }),

  windows_security: () => gen(100, () => {
    const eventIds = [4624, 4625, 4634, 4648, 4672, 4688, 4720, 4726, 5156, 5157];
    const logonTypes = [2, 3, 7, 10, 11];
    const eid = eventIds[r(eventIds.length)];
    const user = USERS[r(USERS.length)];
    const host = HOSTS[r(HOSTS.length)];
    return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-A5BA-3E3B0328C30D}'/><EventID>${eid}</EventID><Level>0</Level><Task>12544</Task><Computer>${host}.corp.local</Computer><TimeCreated SystemTime='${ts()}'/></System><EventData><Data Name='SubjectUserName'>${user}</Data><Data Name='SubjectDomainName'>CORP</Data><Data Name='TargetUserName'>${user}</Data><Data Name='TargetDomainName'>CORP</Data><Data Name='LogonType'>${logonTypes[r(logonTypes.length)]}</Data><Data Name='IpAddress'>${randomIp()}</Data><Data Name='IpPort'>${1024+r(60000)}</Data><Data Name='WorkstationName'>${host}</Data><Data Name='ProcessName'>C:\\Windows\\System32\\svchost.exe</Data><Data Name='Status'>0x0</Data></EventData></Event>`;
  }),

  windows_sysmon: () => gen(100, () => {
    const eventIds = [1, 3, 7, 8, 10, 11, 12, 13, 22];
    const processes = ['svchost.exe', 'powershell.exe', 'cmd.exe', 'explorer.exe', 'chrome.exe', 'notepad.exe', 'wscript.exe'];
    const eid = eventIds[r(eventIds.length)];
    const proc = processes[r(processes.length)];
    const user = USERS[r(USERS.length)];
    return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Sysmon' Guid='{5770385F-C22A-43E0-BF4C-06F5698FFBD9}'/><EventID>${eid}</EventID><Level>4</Level><Computer>${HOSTS[r(HOSTS.length)]}.corp.local</Computer><TimeCreated SystemTime='${ts()}'/></System><EventData><Data Name='RuleName'>technique_id=T${1000+r(600)}</Data><Data Name='UtcTime'>${ts()}</Data><Data Name='ProcessId'>${r(20000)}</Data><Data Name='Image'>C:\\Windows\\System32\\${proc}</Data><Data Name='CommandLine'>${proc} /c dir</Data><Data Name='User'>CORP\\${user}</Data><Data Name='ParentImage'>C:\\Windows\\System32\\${processes[r(processes.length)]}</Data><Data Name='SourceIp'>${randomIp()}</Data><Data Name='DestinationIp'>${publicIp()}</Data><Data Name='DestinationPort'>${[80,443,53,8080][r(4)]}</Data></EventData></Event>`;
  }),

  linux_syslog: () => gen(100, () => {
    const daemons = ['sshd', 'sudo', 'cron', 'systemd', 'kernel', 'NetworkManager', 'postfix/smtpd', 'dockerd'];
    const messages = [
      `Accepted publickey for ${USERS[r(USERS.length)]} from ${publicIp()} port ${1024+r(60000)} ssh2`,
      `pam_unix(sshd:session): session opened for user ${USERS[r(USERS.length)]}`,
      `Failed password for invalid user ${USERS[r(USERS.length)]} from ${publicIp()} port ${1024+r(60000)} ssh2`,
      `${USERS[r(USERS.length)]} : TTY=pts/0 ; PWD=/home ; COMMAND=/bin/systemctl restart nginx`,
      `(${USERS[r(USERS.length)]}) CMD (/usr/local/bin/backup.sh)`,
      `Started Session ${r(1000)} of user ${USERS[r(USERS.length)]}.`,
      `UFW BLOCK IN=eth0 OUT= SRC=${publicIp()} DST=${randomIp()} PROTO=TCP SPT=${1024+r(60000)} DPT=${[22,80,443,3389][r(4)]}`,
    ];
    const daemon = daemons[r(daemons.length)];
    return `${syslogTs()} ${HOSTS[r(HOSTS.length)]} ${daemon}[${r(30000)+100}]: ${messages[r(messages.length)]}`;
  }),

  linux_audit: () => gen(100, () => {
    const types = ['SYSCALL', 'EXECVE', 'CWD', 'PATH', 'USER_AUTH', 'USER_LOGIN', 'USER_CMD'];
    const exes = ['/usr/bin/sudo', '/usr/bin/ssh', '/bin/bash', '/usr/sbin/useradd', '/usr/bin/passwd', '/usr/bin/curl'];
    const type = types[r(types.length)];
    return `type=${type} msg=audit(${Math.floor(Date.now()/1000)}.${r(999)}:${r(99999)}): arch=c000003e syscall=${r(330)} success=yes exit=0 a0=0x${r(99999).toString(16)} ppid=${r(10000)} pid=${r(30000)} auid=${1000+r(5000)} uid=0 gid=0 euid=0 ses=${r(10000)} comm="${exes[r(exes.length)].split('/').pop()}" exe="${exes[r(exes.length)]}" key="audit-${['exec','priv','access','login'][r(4)]}" user=${USERS[r(USERS.length)]} terminal=pts/${r(10)} res=success`;
  }),

  crowdstrike_falcon: () => gen(100, () => {
    const detectionNames = ['Suspicious PowerShell', 'Credential Dumping', 'Lateral Movement', 'Ransomware Activity', 'Malicious Document', 'Process Injection'];
    const severities = ['Critical', 'High', 'Medium', 'Low'];
    const tactics = ['InitialAccess', 'Execution', 'Persistence', 'PrivilegeEscalation', 'DefenseEvasion', 'CredentialAccess', 'LateralMovement'];
    return JSON.stringify({
      timestamp: ts(),
      event_type: 'DetectionSummaryEvent',
      ComputerName: `${HOSTS[r(HOSTS.length)]}.corp.local`,
      UserName: USERS[r(USERS.length)],
      DetectName: detectionNames[r(detectionNames.length)],
      Severity: severities[r(severities.length)],
      Tactic: tactics[r(tactics.length)],
      Technique: `T${1000+r(600)}`,
      FileName: ['powershell.exe', 'cmd.exe', 'rundll32.exe', 'regsvr32.exe', 'mshta.exe'][r(5)],
      FilePath: `C:\\Windows\\System32\\`,
      CommandLine: `powershell.exe -ep bypass -enc ${btoa(`Get-Process`).slice(0,20)}`,
      SHA256: Array.from({length:64}, () => '0123456789abcdef'[r(16)]).join(''),
      LocalIP: randomIp(),
      ExternalIP: publicIp(),
      MachineDomain: 'corp.local',
    });
  }),

  aws_cloudtrail: () => gen(100, () => {
    const events = ['ConsoleLogin', 'AssumeRole', 'CreateUser', 'PutBucketPolicy', 'RunInstances', 'StopInstances', 'CreateSecurityGroup', 'AuthorizeSecurityGroupIngress', 'DeleteBucket'];
    const services = ['iam.amazonaws.com', 'ec2.amazonaws.com', 's3.amazonaws.com', 'sts.amazonaws.com', 'lambda.amazonaws.com'];
    const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
    return JSON.stringify({
      eventVersion: '1.08',
      eventTime: ts(),
      eventSource: services[r(services.length)],
      eventName: events[r(events.length)],
      awsRegion: regions[r(regions.length)],
      sourceIPAddress: publicIp(),
      userIdentity: { type: 'IAMUser', principalId: `AIDA${Array.from({length:16}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[r(32)]).join('')}`, arn: `arn:aws:iam::${100000000000+r(899999999999)}:user/${USERS[r(USERS.length)]}`, accountId: `${100000000000+r(899999999999)}` },
      requestParameters: { instanceType: 'm5.large' },
      responseElements: null,
      userAgent: 'aws-cli/2.13.0',
    });
  }),

  alibaba_action_trail: () => gen(100, () => {
    const eventTypes = ['ApiCall', 'ConsoleOperation', 'AliyunServiceEvent', 'PasswordReset', 'ConsoleSignin', 'ConsoleSignout'];
    const eventType = eventTypes[r(eventTypes.length)];
    const identityTypes = ['root-account', 'ram-user', 'assumed-role', 'cloudsso-user', 'saml-user'];
    const identityType = identityTypes[r(identityTypes.length)];
    const now = Math.floor(Date.now() / 1000) - r(86400);
    return JSON.stringify({
      __time__: String(now),
      __topic__: 'actiontrail_audit_event',
      event: {
        eventType,
        eventId: `${Array.from({length: 8}, () => '0123456789abcdef'[r(16)]).join('')}-${Array.from({length: 4}, () => '0123456789abcdef'[r(16)]).join('')}`,
        eventName: eventType === 'ConsoleSignin' ? 'ConsoleSignin' : ['CreateUser', 'DeleteBucket', 'ModifyInstanceAttribute', 'AssumeRole'][r(4)],
        eventTime: new Date(now * 1000).toISOString(),
        acsRegion: ['cn-hangzhou', 'cn-shanghai', 'eu-central-1', 'ap-southeast-1'][r(4)],
        sourceIpAddress: publicIp(),
        resourceName: `acs:ecs:cn-hangzhou:1234567890123456:instance/i-${Array.from({length: 8}, () => '0123456789abcdef'[r(16)]).join('')}`,
        resourceType: 'ACS::ECS::Instance',
        errorMessage: '',
        userIdentity: {
          type: identityType,
          principalId: `1234567890123456:${USERS[r(USERS.length)]}`,
          userName: USERS[r(USERS.length)],
          accessKeyId: `LTAI${Array.from({length: 16}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[r(36)]).join('')}`,
        },
      },
    });
  }),

  aws_vpc_flow: () => gen(100, () => {
    const actions = ['ACCEPT', 'REJECT'];
    const protos = [6, 17]; // TCP, UDP
    return `2 ${100000000000+r(899999999999)} eni-${Array.from({length:8}, () => '0123456789abcdef'[r(16)]).join('')} ${publicIp()} ${randomIp()} ${1024+r(60000)} ${[80,443,22,3389,53][r(5)]} ${protos[r(protos.length)]} ${r(100)+1} ${r(500000)} ${Math.floor(Date.now()/1000)-r(300)} ${Math.floor(Date.now()/1000)} ${actions[r(actions.length)]} OK`;
  }),

  azure_signin: () => gen(100, () => {
    const statuses = [{ code: 0, reason: 'Success' }, { code: 50126, reason: 'InvalidUserNameOrPassword' }, { code: 50076, reason: 'MfaRequired' }, { code: 53003, reason: 'BlockedByConditionalAccess' }];
    const apps = ['Microsoft Office 365', 'Azure Portal', 'Microsoft Teams', 'SharePoint Online', 'Exchange Online'];
    const status = statuses[r(statuses.length)];
    return JSON.stringify({
      time: ts(),
      category: 'SignInLogs',
      operationName: 'Sign-in activity',
      properties: {
        userDisplayName: USERS[r(USERS.length)],
        userPrincipalName: `${USERS[r(USERS.length)]}@corp.onmicrosoft.com`,
        ipAddress: publicIp(),
        appDisplayName: apps[r(apps.length)],
        clientAppUsed: ['Browser', 'Mobile Apps and Desktop clients', 'Exchange ActiveSync'][r(3)],
        status: { errorCode: status.code, failureReason: status.reason },
        location: { city: ['Amsterdam', 'London', 'New York', 'Singapore'][r(4)], countryOrRegion: ['NL', 'GB', 'US', 'SG'][r(4)] },
        deviceDetail: { operatingSystem: ['Windows 11', 'macOS', 'iOS', 'Android'][r(4)] },
        conditionalAccessStatus: ['success', 'failure', 'notApplied'][r(3)],
        riskLevelDuringSignIn: ['none', 'low', 'medium', 'high'][r(4)],
      },
    });
  }),

  gcp_audit: () => gen(100, () => {
    const methods = ['google.compute.instances.insert', 'google.iam.admin.v1.CreateServiceAccount', 'google.storage.buckets.delete', 'google.compute.firewalls.insert', 'SetIamPolicy'];
    const services = ['compute.googleapis.com', 'iam.googleapis.com', 'storage.googleapis.com', 'bigquery.googleapis.com'];
    return JSON.stringify({
      insertId: `${Array.from({length:12}, () => 'abcdefghijklmnop'[r(16)]).join('')}`,
      timestamp: ts(),
      severity: ['INFO', 'WARNING', 'ERROR'][r(3)],
      logName: `projects/my-project/logs/cloudaudit.googleapis.com%2Factivity`,
      protoPayload: {
        '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
        serviceName: services[r(services.length)],
        methodName: methods[r(methods.length)],
        authenticationInfo: { principalEmail: `${USERS[r(USERS.length)]}@corp.iam.gserviceaccount.com` },
        requestMetadata: { callerIp: publicIp(), callerSuppliedUserAgent: 'google-cloud-sdk gcloud/450.0.0' },
        status: { code: [0, 0, 0, 3, 7][r(5)] },
      },
    });
  }),

  okta_system: () => gen(100, () => {
    const events = ['user.session.start', 'user.authentication.sso', 'user.mfa.factor.activate', 'policy.evaluate_sign_on', 'user.account.lock', 'user.session.end', 'application.user_membership.add'];
    const outcomes = ['SUCCESS', 'FAILURE', 'SKIPPED'];
    const user = USERS[r(USERS.length)];
    return JSON.stringify({
      uuid: `${Array.from({length:8}, () => '0123456789abcdef'[r(16)]).join('')}-${Array.from({length:4}, () => '0123456789abcdef'[r(16)]).join('')}`,
      published: ts(),
      eventType: events[r(events.length)],
      severity: ['INFO', 'WARN', 'ERROR'][r(3)],
      displayMessage: `User ${user} performed action`,
      actor: { id: `00u${Array.from({length:10}, () => 'abcdefghijklmnop'[r(16)]).join('')}`, type: 'User', displayName: user, alternateId: `${user}@corp.com` },
      client: { ipAddress: publicIp(), userAgent: { os: 'Windows 11', browser: 'Chrome' }, geographicalContext: { city: ['Amsterdam', 'London', 'Berlin'][r(3)], country: 'NL' } },
      outcome: { result: outcomes[r(outcomes.length)], reason: '' },
      target: [{ id: `00u${Array.from({length:10}, () => 'abcdefghijklmnop'[r(16)]).join('')}`, type: 'User', displayName: user }],
    });
  }),

  zscaler_web: () => gen(100, () => {
    const actions = ['Allowed', 'Blocked', 'Cautioned', 'Isolated'];
    const categories = ['News/Media', 'Business', 'Technology', 'Social Networking', 'Malware', 'Phishing', 'Adult Content'];
    const user = USERS[r(USERS.length)];
    return JSON.stringify({
      datetime: ts(),
      user: `${user}@corp.com`,
      department: ['Engineering', 'Sales', 'IT', 'Finance'][r(4)],
      url: `https://www.example${r(999)}.com/path/${r(9999)}`,
      action: actions[r(actions.length)],
      urlcategory: categories[r(categories.length)],
      clientip: randomIp(),
      serverip: publicIp(),
      requestsize: r(50000),
      responsesize: r(500000),
      urlclass: 'Business Use',
      deviceowner: user,
      devicehostname: `${user}-laptop`,
      riskscore: r(100),
    });
  }),

  apache_access: () => gen(100, () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'];
    const paths = ['/index.html', '/api/v1/users', '/api/v1/health', '/static/app.js', '/login', '/api/v1/orders', '/favicon.ico', '/dashboard'];
    const statuses = [200, 200, 200, 301, 304, 400, 401, 403, 404, 500];
    return `${publicIp()} - ${USERS[r(USERS.length)]} [${syslogTs()} +0000] "${methods[r(methods.length)]} ${paths[r(paths.length)]} HTTP/1.1" ${statuses[r(statuses.length)]} ${r(50000)} "https://www.example.com/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"`;
  }),

  nginx_access: () => gen(100, () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE'];
    const paths = ['/api/auth', '/api/data', '/health', '/static/bundle.js', '/graphql', '/api/v2/events', '/ws'];
    const statuses = [200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 502, 503];
    const upstreams = ['10.0.1.10:8080', '10.0.1.11:8080', '10.0.1.12:8080'];
    return `${publicIp()} - - [${syslogTs()} +0000] "${methods[r(methods.length)]} ${paths[r(paths.length)]} HTTP/2.0" ${statuses[r(statuses.length)]} ${r(50000)} "${['https://app.example.com', '-'][r(2)]}" "Mozilla/5.0" rt=${(r(5000)/1000).toFixed(3)} uct="${(r(100)/1000).toFixed(3)}" uht="${(r(500)/1000).toFixed(3)}" urt="${(r(5000)/1000).toFixed(3)}" upstream="${upstreams[r(upstreams.length)]}"`;
  }),
};

function gen(count: number, factory: (i: number) => string): string[] {
  return Array.from({ length: count }, (_, i) => factory(i));
}

export function generateSamples(sourcetype: string): string {
  const generator = generators[sourcetype] || generators.linux_syslog;
  return generator().join('\n');
}

export function hasBuiltInSamples(sourcetype: string): boolean {
  return Object.prototype.hasOwnProperty.call(generators, sourcetype);
}
