var e=[{_time:1653060352,cribl_breaker:`Break on newlines`,_raw:`05/20/2022 10:25:52 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4627
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Group Membership
OpCode=Info
RecordNumber=8600571286
Keywords=Audit Success
Message=Group membership information.\r
\r
Subject:\r
	Security ID:		NULL SID\r
	Account Name:		-\r
	Account Domain:		-\r
	Logon ID:		0x0\r
\r
Logon Type:			3\r
\r
New Logon:\r
	Security ID:		ACMEEMAIL\\Svc_Account\r
	Account Name:		Svc_someaccount\r
	Account Domain:		ACME.COM\r
	Logon ID:		0x9ED8964\r
\r
Event in sequence:		1 of 1\r
\r
Group Membership:			\r
		Everyone\r
		ACMEEMAIL\\Distributed COM Users\r
\r
The subject fields indicate the account on the local system which requested the logon. This is most commonly a service such as the Server service, or a local process such as Winlogon.exe or Services.exe.\r
\r
The logon type field indicates the kind of logon that occurred. The most common types are 2 (interactive) and 3 (network).\r
\r
The New Logon fields indicate the account for whom the new logon was created, i.e. the account that was logged on.\r
\r
This event is generated when the Audit Group Membership subcategory is configured.  The Logon ID field can be used to correlate this event with the corresponding user logon event as well as to any other security audit events generated during this logon session.`}];export{e as default};