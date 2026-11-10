var e=[{_time:1653597184,cribl_breaker:`Break on newlines`,_raw:`05/26/2022 03:32:08 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4699
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Other Object Access Events
OpCode=Info
RecordNumber=6477538801
Keywords=Audit Success
Message=A scheduled task was deleted.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\SYSTEM\r
	Account Name:		SomeAccount$\r
	Account Domain:		ACME\r
	Logon ID:		0x3E7\r
\r
Task Information:\r
	Task Name: 		\\Microsoft\\Office\\Office Serviceability Manager\r
	Task Content: 		<?xml version="1.0" encoding="UTF-16"?>\r
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r
  <RegistrationInfo>\r
<Date>2019-09-16T18:36:42.480046</Date>\r
    <Author>Microsoft Office</Author>\r
    <Description>Helps your administrator manage and keep Microsoft Office software up to date. If this task is disabled or stopped, your administrator will not be able to manage Microsoft Office software to keep it up to date, meaning security vulnerabilities that may arise cannot be fixed and features may not work. This task uninstalls itself when there is no Microsoft software using it.</Description>\r
    <URI>\\Microsoft\\Office\\Office Serviceability Manager</URI>\r
  </RegistrationInfo>\r
  <Triggers>\r
    <CalendarTrigger>\r
      <Repetition>\r
        <Interval>PT2709M</Interval>\r
        <StopAtDurationEnd>false</StopAtDurationEnd>\r
      </Repetition>\r
<StartBoundary>2022-05-27T02:03:04</StartBoundary>\r
      <Enabled>true</Enabled>\r
      <ScheduleByDay>\r
        <DaysInterval>1</DaysInterval>\r
      </ScheduleByDay>\r
    </CalendarTrigger>\r
  </Triggers>\r
  <Principals>\r
    <Principal id="Author">\r
      <UserId>NT AUTHORITY\\SYSTEM</UserId>\r
      <RunLevel>HighestAvailable</RunLevel>\r
      <LogonType>InteractiveToken</LogonType>\r
    </Principal>\r
  </Principals>\r
  <Settings>\r
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r
    <AllowHardTerminate>true</AllowHardTerminate>\r
    <StartWhenAvailable>true</StartWhenAvailable>\r
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r
    <IdleSettings>\r
      <StopOnIdleEnd>false</StopOnIdleEnd>\r
      <RestartOnIdle>false</RestartOnIdle>\r
    </IdleSettings>\r
    <AllowStartOnDemand>true</AllowStartOnDemand>\r
    <Enabled>true</Enabled>\r
    <Hidden>false</Hidden>\r
    <RunOnlyIfIdle>false</RunOnlyIfIdle>\r
    <WakeToRun>false</WakeToRun>\r
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>\r
    <Priority>7</Priority>\r
    <RestartOnFailure>\r
      <Interval>PT30M</Interval>\r
      <Count>3</Count>\r
    </RestartOnFailure>\r
  </Settings>\r
  <Actions Context="Author">\r
    <Exec>\r
      <Command>C:\\Program Files\\Common Files\\Microsoft Shared\\ClickToRun\\officesvcmgr.exe</Command>\r
      <Arguments>/checkin</Arguments>\r
    </Exec>\r
  </Actions>\r
</Task>`}];export{e as default};