var e=[{_time:1566444095,cribl_breaker:`Break on newlines`,_raw:`08/21/2019 10:21:35 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4656
EventType=0
Type=Information
ComputerName=MYHOST
TaskCategory=Removable Storage
OpCode=Info
RecordNumber=795900
Keywords=Audit Success
Message=A handle to an object was requested.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\SYSTEM\r
	Account Name:		JSMITH$\r
	Account Domain:		WORKGROUP\r
	Logon ID:		0x3E7\r
\r
Object:\r
	Object Server:		Security\r
	Object Type:		File\r
	Object Name:		\\Device\\Floppy0\r
	Handle ID:		0x7e8\r
	Resource Attributes:	-\r
\r
Process Information:\r
	Process ID:		0x7cc\r
	Process Name:		C:\\Program Files\\VMware\\VMware Tools\\vmtoolsd.exe\r
\r
Access Request Information:\r
	Transaction ID:		{00000000-0000-0000-0000-000000000000}\r
	Accesses:		READ_CONTROL\r
				SYNCHRONIZE\r
				ReadData (or ListDirectory)\r
				ReadEA\r
				ReadAttributes\r
				\r
	Access Reasons:		-\r
	Access Mask:		0x120089\r
	Privileges Used for Access Check:	-\r
	Restricted SID Count:	0`},{_time:1566427693,cribl_breaker:`Break on newlines`,_raw:`08/21/2019 05:48:13 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4660
EventType=0
Type=Information
ComputerName=MYHOST
TaskCategory=Removable Storage
OpCode=Info
RecordNumber=115625
Keywords=Audit Success
Message=An object was deleted.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\SYSTEM\r
	Account Name:		JSMITH$\r
	Account Domain:		WORKGROUP\r
	Logon ID:		0x3E7\r
\r
Object:\r
	Object Server:	Security\r
	Handle ID:	0x2bc\r
\r
Process Information:\r
	Process ID:	0x1c68\r
	Process Name:	C:\\Windows\\System32\\poqexec.exe\r
	Transaction ID:	{4A260C1A-C413-11E9-8649-000C294DA8F3}`},{_time:1566443012,cribl_breaker:`Break on newlines`,_raw:`08/21/2019 10:03:32 PM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4663
EventType=0
Type=Information
ComputerName=HYHOST
TaskCategory=Removable Storage
OpCode=Info
RecordNumber=121801
Keywords=Audit Success
Message=An attempt was made to access an object.\r
\r
Subject:\r
	Security ID:		VIJEO\\Admin\r
	Account Name:		JSMITH\r
	Account Domain:		ACME\r
	Logon ID:		0x199B38\r
\r
Object:\r
	Object Server:		Security\r
	Object Type:		File\r
	Object Name:		\\Device\\HarddiskVolume5\\._ismHost.exe.zip\r
	Handle ID:		0x5558\r
	Resource Attributes:	\r
\r
Process Information:\r
	Process ID:		0xdd0\r
	Process Name:		C:\\Windows\\explorer.exe\r
\r
Access Request Information:\r
	Accesses:		ReadData (or ListDirectory)\r
				\r
	Access Mask:		0x1`}];export{e as default};