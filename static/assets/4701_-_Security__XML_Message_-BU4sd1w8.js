var e=[{_time:1655222442,cribl_breaker:`Break on newlines`,index:`wineventlog`,source:`WinEventLog:Security`,sourcetype:`WinEventLog:Security`,_raw:`06/14/2022 11:00:42 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4701
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Other Object Access Events
OpCode=Info
RecordNumber=803245816
Keywords=Audit Success
Message=A scheduled task was disabled.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\NETWORK SERVICE\r
	Account Name:		myhost$\r
	Account Domain:		ACME\r
	Logon ID:		0x3E4\r
\r
Task Information:\r
	Task Name: 		\\Microsoft\\Windows\\SoftwareProtectionPlatform\\SvcRestartTaskLogon\r
	Task Content: 		<?xml version="1.0" encoding="UTF-16"?>\r
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r
  <RegistrationInfo>\r
    <URI>\\Microsoft\\Windows\\SoftwareProtectionPlatform\\SvcRestartTaskLogon</URI>\r
    <SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFW;;;S-1-5-80-123231216-2592883651-3715271367-3753151631-4175906628)(A;;FR;;;S-1-5-4)</SecurityDescriptor>\r
    <Version>1.0</Version>\r
    <Source>$(@%systemroot%\\system32\\sppc.dll,-200)</Source>\r
    <Author>$(@%systemroot%\\system32\\sppc.dll,-200)</Author>\r
    <Description>$(@%systemroot%\\system32\\sppc.dll,-202)</Description>\r
  </RegistrationInfo>\r
  <Triggers>\r
    <LogonTrigger>\r
      <Enabled>true</Enabled>\r
    </LogonTrigger>\r
  </Triggers>\r
  <Principals>\r
    <Principal id="InteractiveUser">\r
      <GroupId>S-1-5-4</GroupId>\r
    </Principal>\r
  </Principals>\r
  <Settings>\r
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r
    <AllowHardTerminate>false</AllowHardTerminate>\r
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r
    <AllowStartOnDemand>true</AllowStartOnDemand>\r
    <Enabled>false</Enabled>\r
    <Hidden>true</Hidden>\r
    <RunOnlyIfIdle>false</RunOnlyIfIdle>\r
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>\r
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>\r
    <WakeToRun>false</WakeToRun>\r
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\r
    <Priority>7</Priority>\r
    <RestartOnFailure>\r
      <Interval>PT1M</Interval>\r
      <Count>3</Count>\r
    </RestartOnFailure>\r
  </Settings>\r
  <Actions Context="InteractiveUser">\r
    <ComHandler>\r
      <ClassId>{b1aebb5d-ead9-4476-b375-9c3ed9f32afc}</ClassId>\r
      <Data><![CDATA[logon]]></Data>\r
    </ComHandler>\r
  </Actions>\r
</Task>`}];export{e as default};