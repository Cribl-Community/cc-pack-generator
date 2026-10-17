var e=[{_raw:`03/15/2022 11:59:59 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4625
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Account Lockout
OpCode=Info
RecordNumber=123456789
Keywords=Audit Failure
Message=An account failed to log on.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\SYSTEM\r
	Account Name:		SETEST$\r
	Account Domain:		ACME.COM\r
	Logon ID:		0x3E7\r
\r
Logon Type:			3\r
\r
Account For Which Logon Failed:\r
	Security ID:		NULL SID\r
	Account Name:		a0000287\r
	Account Domain:		ACME-GLOBAL\r
\r
Failure Information:\r
	Failure Reason:		Account locked out.\r
	Status:			0xC0000234\r
	Sub Status:		0x0\r
\r
Process Information:\r
	Caller Process ID:	0x21c\r
	Caller Process Name:	C:\\Windows\\System32\\lsass.exe\r
\r
Network Information:\r
	Workstation Name:	ABCDEFGUSA01\r
	Source Network Address:	10.1.2.3\r
	Source Port:		37988\r
\r
Detailed Authentication Information:\r
	Logon Process:		Advapi  \r
	Authentication Package:	MICROSOFT_AUTHENTICATION_PACKAGE_V1_0\r
	Transited Services:	-\r
	Package Name (NTLM only):	-\r
	Key Length:		0\r
\r
This event is generated when a logon request fails. It is generated on the computer where access was attempted.\r
\r
The Subject fields indicate the account on the local system which requested the logon. This is most commonly a service such as the Server service, or a local process such as Winlogon.exe or Services.exe.\r
\r
The Logon Type field indicates the kind of logon that was requested. The most common types are 2 (interactive) and 3 (network).\r
\r
The Process Information fields indicate which account and process on the system requested the logon.\r
\r
The Network Information fields indicate where a remote logon request originated. Workstation name is not always available and may be left blank in some cases.\r
\r
The authentication information fields provide detailed information about this specific logon request.\r
	- Transited services indicate which intermediate services have participated in this logon request.\r
	- Package name indicates which sub-protocol was used among the NTLM protocols.\r
	- Key length indicates the length of the generated session key. This will be 0 if no session key was requested.`,_time:1647406799,cribl_breaker:`ndjson`}];export{e as default};