var e=[{_time:1671735551.246,cribl_breaker:`Break on newlines`,_raw:`12/22/2022 01:58:46 PM
LogName=Microsoft-Windows-PowerShell/Operational
SourceName=Microsoft-Windows-PowerShell
EventCode=4103
EventType=4
Type=Information
ComputerName=myhost.acme.com
User=SYSTEM
Sid=S-1-5-18
SidType=1
TaskCategory=Executing Pipeline
OpCode=To be used when operation is just executing a method
RecordNumber=4822371469
Keywords=None
Message=CommandInvocation(Write-Host): "Write-Host"\r
ParameterBinding(Write-Host): name="Object"; value="2022-12-22T13:58:46-05:00 User="Jsmith" Folder="/Some Folder" Type="User Created" Size=1277390 Items=362"\r
\r
\r
Context:\r
        Severity = Informational\r
        Host Name = ConsoleHost\r
        Host Version = 5.1.14393.5127\r
        Host ID = fe6c9340-986c-4587-a0a4-8d39033a361f\r
        Host Application = Powershell -PSConsoleFile C:\\Program Files\\Microsoft\\Exchange Server\\V15\\\\bin\\exshell.psc1 -command . 'C:\\Program Files\\SplunkUniversalForwarder\\etc\\apps\\TA-Exchange-Mailbox\\bin\\powershell\\get-somestats_2013.ps1'\r
        Engine Version = 5.1.14393.5127\r
        Runspace ID = d5a0f534-1409-4d66-b7c2-de3bc8004868\r
        Pipeline ID = 1\r
        Command Name = Write-Host\r
        Command Type = Cmdlet\r
        Script Name = C:\\Program Files\\SplunkUniversalForwarder\\etc\\apps\\TA-Exchange-Mailbox\\bin\\powershell\\get-somestats_2013.ps1\r
        Command Path = \r
        Sequence Number = 2283255\r
        User = AD\\SYSTEM\r
        Connected User = \r
        Shell ID = Microsoft.PowerShell\r
\r
\r
User Data:`,source:`WinEventLog:Microsoft-Windows-Powershell/Operational`}];export{e as default};