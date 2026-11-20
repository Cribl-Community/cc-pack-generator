var e=[{_time:1653016830,cribl_breaker:`Break on newlines`,_raw:`05/20/2022 08:50:30 AM
LogName=Security
SourceName=Microsoft Windows security auditing.
EventCode=5447
EventType=0
Type=Information
ComputerName=myhost.acme.com
TaskCategory=Other Policy Change Events
OpCode=Info
RecordNumber=1234660239
Keywords=Audit Success
Message=A Windows Filtering Platform filter has been changed.\r
	\r
Subject:\r
	Security ID:		NT AUTHORITY\\LOCAL SERVICE\r
	Account Name:		NT AUTHORITY\\LOCAL SERVICE\r
\r
Process Information:\r
	Process ID:	1238\r
\r
Provider Information:\r
	ID:		{4B112335-1049-1230-AAB4-D1B9BDC03710}\r
	Name:		Microsoft Corporation\r
\r
Change Information:\r
	Change Type:	Delete\r
\r
Filter Information:\r
	ID:		{D9119042-B968-1230-A554-FF4A9D5512E2}\r
	Name:		InternetClient Default Rule\r
	Type:		Not persistent\r
	Run-Time ID:	31969924\r
\r
Layer Information:\r
	ID:		{4A12393B-319F-44BC-84C3-BA54DCB3B6B4}\r
	Name:		ALE Connect v6 Layer\r
	Run-Time ID:	50\r
\r
Callout Information:\r
	ID:		{00000000-0000-0000-0000-000000000000}\r
	Name:		-\r
\r
Additional Information:\r
	Weight:	51123608060	\r
	Conditions:	
	Condition ID:	{71bc78fa-f17c-4997-a602-6abb123f351c}
	Match value:	Not equal to
	Condition value:	-

	Condition ID:	{b235ae9a-1d64-12b8-a44c-5ff3d1235045}
	Match value:	In range
	Condition value:	00000000000000000000000000000000 - ffffffffffffffffffffffffffffffff

	Condition ID:	{46ea1551-1235-492b-8019-aabeee349f40}
	Match value:	Equal to
	Condition value:	0x00000002

	Condition ID:	{ab1233c9-c0e3-4759-937d-5758c65d4ae3}
	Match value:	Equal to
	Condition value:	0x00000002

	Condition ID:	{af123a0a-b34d-4f86-979c-c90371af6e66}
	Match value:	Equal to
	Condition value:	
O:LSD:(A;;CC;;;S-1-12-3-1)(A;;CC;;;WD)(A;;CC;;;AN)

\r
	Filter Action:	Permit`}];export{e as default};