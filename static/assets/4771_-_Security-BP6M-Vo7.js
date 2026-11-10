var e=[{_time:1653035300,cribl_breaker:`Break on newlines`,_raw:`05/20/2022 03:28:20 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4771
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Kerberos Authentication Service
OpCode=Info
RecordNumber=2922704672
Keywords=Audit Failure
Message=Kerberos pre-authentication failed.\r
\r
Account Information:\r
	Security ID:		ACME\\SomeUser\r
	Account Name:		SomeName\r
\r
Service Information:\r
	Service Name:		SomeService/ACME\r
\r
Network Information:\r
	Client Address:		::ffff:10.1.2.3\r
	Client Port:		49656\r
\r
Additional Information:\r
	Ticket Options:		0x40812310\r
	Failure Code:		0x12\r
	Pre-Authentication Type:	0\r
\r
Certificate Information:\r
	Certificate Issuer Name:		\r
	Certificate Serial Number: 	\r
	Certificate Thumbprint:		\r
\r
Certificate information is only provided if a certificate was used for pre-authentication.\r
\r
Pre-authentication types, ticket options and failure codes are defined in RFC 4120.\r
\r
If the ticket was malformed or damaged during transit and could not be decrypted, then many fields in this event might not be present.`}];export{e as default};