var e=[{_time:1661886167,cribl_breaker:`Break on newlines`,_raw:`08/30/2022 12:02:47 PM\r
LogName=Security\r
SourceName=AD FS Auditing\r
EventCode=403\r
EventType=0\r
Type=Information\r
ComputerName=myhost.acme.com\r
User=NOT_TRANSLATED\r
Sid=S-1-5-21-359538278-12365162-2211038576-184163\r
SidType=0\r
TaskCategory=Printers\r
OpCode=Info\r
RecordNumber=68106994\r
Keywords=Audit Success, Classic\r
Message=An HTTP request was received. See audit 510 with the same Instance ID for headers. \r\r
\r\r
Instance ID: 123b21a3-bc59-448f-a1f9-99f4d4f8a967 \r\r
\r\r
Activity ID: 99b12344-b933-4312-311d-0080011000d4 \r\r
\r\r
Request Details: \r\r
    Date And Time: 2022-08-30 19:02:47 \r\r
    Client IP: 10.1.2.3 \r\r
    HTTP Method: POST \r\r
    Url Absolute Path: /adfs/oauth2/token \r\r
    Query string: - \r\r
    Local Port: 443 \r\r
    Local IP: 10.1.2.3 \r\r
    User Agent: - \r\r
    Content Length: 190 \r\r
    Caller Identity: - \r\r
    Certificate Identity (if any): - \r\r
    Targeted relying party: - \r\r
    Through proxy: False \r\r
    Proxy DNS name: -`,source:`WinEventLog:Security`,host:`myhost.acme.com`,sourcetype:`WinEventLog:Security`,index:`wineventlog`}];export{e as default};