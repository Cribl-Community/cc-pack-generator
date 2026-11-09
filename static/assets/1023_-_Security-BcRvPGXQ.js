var e=[{_time:1661886168,cribl_breaker:`Break on newlines`,_raw:`08/30/2022 12:02:48 PM\r
LogName=Security\r
SourceName=AD FS Auditing\r
EventCode=1023\r
EventType=0\r
Type=Information\r
ComputerName=myhost.acme.com\r
User=NOT_TRANSLATED\r
Sid=S-1-5-21-359538278-52765162-2211038576-184163\r
SidType=0\r
TaskCategory=Printers\r
OpCode=Info\r
RecordNumber=68107060\r
Keywords=Audit Success, Classic\r
Message=An OAuth access token was successfully issued to client 'f9b31a3c-9d79-49df-a3cc-a49574d32e32' for the relying party 'https://management.acme.com/'.  See audit 500 with the same Instance ID for issued claims.  See audit 501 with the same Instance ID for caller identity. \r\r
\r\r
Instance ID: d18c7d57-f8f1-4eea-123c-e4cb7fefed7c \r\r
\r\r
Activity ID: 6e61ee28-df98-4ba4-ed08-12300124003f \r\r
\r\r
Authorization Code ID (if authorization code request): - \r\r
\r\r
User code (if device flow request): %11 \r\r
\r\r
Request Details: \r\r
    Date And Time: %4 \r\r
    Client IP: %5 \r\r
    Client Identifier: %6 \r\r
    Client Redirect URI: %7 \r\r
    Resource: %8 \r\r
    User Identity: %9 \r\r
    Device Identity: %10`,source:`WinEventLog:Security`,host:`myhost.acme.com`,sourcetype:`WinEventLog:Security`,index:`wineventlog`}];export{e as default};