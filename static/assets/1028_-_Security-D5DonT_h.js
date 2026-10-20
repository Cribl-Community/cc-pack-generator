var e=[{_time:1661886167,cribl_breaker:`Break on newlines`,_raw:`08/30/2022 12:02:47 PM\r
LogName=Security\r
SourceName=AD FS Auditing\r
EventCode=1028\r
EventType=0\r
Type=Information\r
ComputerName=myhost.acme.com\r
User=NOT_TRANSLATED\r
Sid=S-1-5-21-359538278-52765162-1231038576-184163\r
SidType=0\r
TaskCategory=Printers\r
OpCode=Info\r
RecordNumber=68106997\r
Keywords=Audit Success, Classic\r
Message=OAuth Confidential Client '72e8f123-66c6-47e0-a5fe-db08dfbed491' was successfully authenticated using tokentype 'Microsoft.IdentityServer.Web.Protocols.OAuth.OAuthClientSecretSecurityToken'. See audit 501 with the same Instance ID for claims generated during client authentication.  \r\r
\r\r
Instance ID: a1234f48-e91c-40c7-9fec-ff62e49f2fa2 \r\r
\r\r
Activity ID: f42c9d36-b123-445a-311d-0080011000d4 \r\r
\r\r
Request Details: \r\r
    TokenType: Microsoft.IdentityServer.Web.Protocols.OAuth.OAuthClientSecretSecurityToken \r\r
    Date And Time: 2022-08-30 19:02:47 \r\r
    Client IP: 10.1.2.3 \r\r
    Client Identifier: 72e8f008-66c6-47e0-a5fe-db08dfbed123`,source:`WinEventLog:Security`,host:`myhost.acme.com`,sourcetype:`WinEventLog:Security`,index:`wineventlog`}];export{e as default};