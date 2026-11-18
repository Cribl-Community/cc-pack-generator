var e=[{_time:1646233187,_raw:`03/02/2022 08:59:47 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4624
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Logon
OpCode=Info
RecordNumber=31520297959
Keywords=Audit Success
Message=An account was successfully logged on.\r
\r
Subject:\r
	Security ID:		NULL SID\r
	Account Name:		-\r
	Account Domain:		-\r
	Logon ID:		0x0\r
\r
Logon Information:\r
	Logon Type:		3\r
	Restricted Admin Mode:	-\r
	Virtual Account:		No\r
	Elevated Token:		Yes\r
\r
Impersonation Level:		Delegation\r
\r
New Logon:\r
	Security ID:		ACME\\SETEST$\r
	Account Name:		SETEST$\r
	Account Domain:		ACME.COM\r
	Logon ID:		0x1FA6E0F28\r
	Linked Logon ID:		0x0\r
	Network Account Name:	-\r
	Network Account Domain:	-\r
	Logon GUID:		{00000000-0000-0000-0000-000000000000}\r
\r
Process Information:\r
	Process ID:		0x0\r
	Process Name:		-\r
\r
Network Information:\r
	Workstation Name:	-\r
	Source Network Address:	10.1.2.3\r
	Source Port:		63066\r
\r
Detailed Authentication Information:\r
	Logon Process:		Kerberos\r
	Authentication Package:	Kerberos\r
	Transited Services:	-\r
	Package Name (NTLM only):	-\r
	Key Length:		0\r
\r
This event is generated when a logon session is created. It is generated on the computer that was accessed.\r
\r
The subject fields indicate the account on the local system which requested the logon. This is most commonly a service such as the Server service, or a local process such as Winlogon.exe or Services.exe.\r
\r
The logon type field indicates the kind of logon that occurred. The most common types are 2 (interactive) and 3 (network).\r
\r
The New Logon fields indicate the account for whom the new logon was created, i.e. the account that was logged on.\r
\r
The network fields indicate where a remote logon request originated. Workstation name is not always available and may be left blank in some cases.\r
\r
The impersonation level field indicates the extent to which a process in the logon session can impersonate.\r
\r
The authentication information fields provide detailed information about this specific logon request.\r
	- Logon GUID is a unique identifier that can be used to correlate this event with a KDC event.\r
	- Transited services indicate which intermediate services have participated in this logon request.\r
	- Package name indicates which sub-protocol was used among the NTLM protocols.\r
	- Key length indicates the length of the generated session key. This will be 0 if no session key was requested.`}];export{e as default};