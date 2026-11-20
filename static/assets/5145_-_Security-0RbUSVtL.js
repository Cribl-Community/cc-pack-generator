var e=[{_time:1647410399,cribl_breaker:`Break on newlines`,_raw:`03/16/2022 12:59:59 AM\r
LogName=Security\r
SourceName=Microsoft Windows security auditing.\r
EventCode=5145\r
EventType=0\r
Type=Information\r
ComputerName=myhost.acme.com\r
TaskCategory=Detailed File Share\r
OpCode=Info\r
RecordNumber=1162631635\r
Keywords=Audit Success\r
Message=A network share object was checked to see whether client can be granted desired access.\r\r
	\r\r
Subject:\r\r
	Security ID:		ACMEEMAIL\\Svc_some_name\r\r
	Account Name:		Svc_some_name\r\r
	Account Domain:		ACMEEMAIL\r\r
	Logon ID:		0x40192BE4D\r\r
\r\r
Network Information:	\r\r
	Object Type:		File\r\r
	Source Address:		10.1.2.3\r\r
	Source Port:		50706\r\r
	\r\r
Share Information:\r\r
	Share Name:		\\\\SomeName\\SomeShare\r\r
	Share Path:		\\??\\E:\\SomePath\r\r
	Relative Target Name:	Interfaces\\ACME\\IN\\Adjustments\r\r
\r\r
Access Request Information:\r\r
	Access Mask:		0x100081\r\r
	Accesses:		SYNCHRONIZE\r\r
				ReadData (or ListDirectory)\r\r
				ReadAttributes\r\r
				\r\r
Access Check Results:\r\r
	SYNCHRONIZE:	Granted by	D:(A;ABCI;FA;;;AB)\r\r
				ReadData (or ListDirectory):	Granted by	D:(A;OICI;FA;;;AB)\r\r
				ReadAttributes:	Granted by	D:(A;OICI;FA;;;AB)`}];export{e as default};