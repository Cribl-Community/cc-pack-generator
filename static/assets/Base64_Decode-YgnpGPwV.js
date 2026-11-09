var e=[{_raw:`07/21/2021 12:47:59 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4688
EventType=0
Type=Information
ComputerName=HOSTNAME.com
TaskCategory=Process Creation
OpCode=Info
RecordNumber=187983697
Keywords=Audit Success
Message=A new process has been created.
Creator Subject:
	Security ID:		NT AUTHORITY\\SYSTEM
	Account Name:		USERID$
	Account Domain:		ABCDE
	Logon ID:		0x3E7
Target Subject:
	Security ID:		NULL SID
	Account Name:		-
	Account Domain:		-
	Logon ID:		0x0
Process Information:
	New Process ID:		0x1560
	New Process Name:	C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
	Token Elevation Type:	%%1936
	Mandatory Label:		Mandatory Label\\System Mandatory Level
	Creator Process ID:	0xa08
	Creator Process Name:	C:\\Program Files\\Nutanix\\Python27\\Lib\\site-packages\\win32\\pythonservice.exe
	Process Command Line:	powershell.exe -NoProfile -EncodedCommand RwBlAHQALQBXAG0AaQBPAGIAagBlAGMAdAAgAC0ATgBhAG0AZQBzAHAAYQBjAGUAIAByAG8AbwB0AFwAdwBtAGkAIAAtAEMAbABhAHMAcwAgAE0AUwBpAFMAQwBTAEkASQBuAGkAdABpAGEAdABvAHIAXwBTAGUAbgBkAFQAYQByAGcAZQB0AFAAbwByAHQAYQBsAEMAbABhAHMAcwAgAHwAIABGAG8AcgBlAGEAYwBoAC0ATwBiAGoAZQBjAHQAIAB7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACQAXwAuAFAAbwByAHQAYQBsAEEAZABkAHIAZQBzAHMAIAB9AA==
Token Elevation Type indicates the type of token that was assigned to the new process in accordance with User Account Control policy.
Type 1 is a full token with no privileges removed or groups disabled.  A full token is only used if User Account Control is disabled or if the user is the built-in Administrator account or a service account.
Type 2 is an elevated token with no privileges removed or groups disabled.  An elevated token is used when User Account Control is enabled and the user chooses to start the program using Run as administrator.  An elevated token is also used when an application is configured to always require administrative privilege or to always require maximum privilege, and the user is a member of the Administrators group.
Type 3 is a limited token with administrative privileges removed and administrative groups disabled.  The limited token is used when User Account Control is enabled, the application does not require administrative privilege, and the user does not choose to start the program using Run as administrator.`,_time:1626889679,cribl_breaker:`Break on newlines`}];export{e as default};