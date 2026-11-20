var e=[{_time:1653060405,cribl_breaker:`Break on newlines`,_raw:`05/20/2022 10:26:45 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=4663
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Kernel Object
OpCode=Info
RecordNumber=123363557
Keywords=Audit Success
Message=An attempt was made to access an object.\r
\r
Subject:\r
	Security ID:		NT AUTHORITY\\SYSTEM\r
	Account Name:		SOMEUSER$\r
	Account Domain:		ACME\r
	Logon ID:		0x3E7\r
\r
Object:\r
	Object Server:		Security\r
	Object Type:		Process\r
	Object Name:		\\Device\\HarddiskVolume1\\Windows\\System32\\lsass.exe\r
	Handle ID:		0x62c\r
	Resource Attributes:	-\r
\r
Process Information:\r
	Process ID:		0xb40\r
	Process Name:		C:\\Windows\\System32\\wbem\\WmiPrvSE.exe\r
\r
Access Request Information:\r
	Accesses:		Read from process memory\r
				\r
	Access Mask:		0x10`}];export{e as default};