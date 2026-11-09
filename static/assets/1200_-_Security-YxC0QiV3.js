var e=[{_time:1661886167,cribl_breaker:`Break on newlines`,_raw:`08/30/2022 12:02:47 PM\r
LogName=Security\r
SourceName=AD FS Auditing\r
EventCode=1200\r
EventType=0\r
Type=Information\r
ComputerName=myhost.acme.com\r
User=NOT_TRANSLATED\r
Sid=S-1-5-21-359538278-52765162-2211038576-184163\r
SidType=0\r
TaskCategory=Printers\r
OpCode=Info\r
RecordNumber=68107005\r
Keywords=Audit Success, Classic\r
Message=The Federation Service issued a valid token. See XML for details. \r\r
\r\r
Activity ID: f42c9d36-b836-445a-311d-0080011000d4 \r\r
\r\r
Additional Data \r\r
XML: <?xml version="1.0" encoding="utf-16"?>\r\r
<AuditBase xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AppTokenAudit">\r\r
  <AuditType>AppToken</AuditType>\r\r
  <AuditResult>Success</AuditResult>\r\r
  <FailureType>None</FailureType>\r\r
  <ErrorCode>N/A</ErrorCode>\r\r
  <ContextComponents>\r\r
    <Component xsi:type="ResourceAuditComponent">\r\r
      <RelyingParty>https://subhost.myhost.com/WarpAuthAPI</RelyingParty>\r\r
      <ClaimsProvider>FEDERATED AUTHORITY</ClaimsProvider>\r\r
      <UserId>N/A</UserId>\r\r
    </Component>\r\r
    <Component xsi:type="AuthNAuditComponent">\r\r
      <PrimaryAuth>http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password</PrimaryAuth>\r\r
      <DeviceAuth>false</DeviceAuth>\r\r
      <DeviceId>N/A</DeviceId>\r\r
      <MfaPerformed>false</MfaPerformed>\r\r
      <MfaMethod>N/A</MfaMethod>\r\r
      <TokenBindingProvidedId>false</TokenBindingProvidedId>\r\r
      <TokenBindingReferredId>false</TokenBindingReferredId>\r\r
      <SsoBindingValidationLevel>NotSet</SsoBindingValidationLevel>\r\r
    </Component>\r\r
    <Component xsi:type="ProtocolAuditComponent">\r\r
      <OAuthClientId>72e8f123-66c6-47e0-a5fe-db08dfbed491</OAuthClientId>\r\r
      <OAuthGrant>N/A</OAuthGrant>\r\r
    </Component>\r\r
    <Component xsi:type="RequestAuditComponent">\r\r
      <Server>http://sso.myhost.com/adfs/services/trust</Server>\r\r
      <AuthProtocol>OAuth</AuthProtocol>\r\r
      <NetworkLocation>Intranet</NetworkLocation>\r\r
      <IpAddress>10.1.2.3</IpAddress>\r\r
      <ForwardedIpAddress>10.1.2.3</ForwardedIpAddress>\r\r
      <ProxyIpAddress>N/A</ProxyIpAddress>\r\r
      <NetworkIpAddress>N/A</NetworkIpAddress>\r\r
      <ProxyServer>N/A</ProxyServer>\r\r
      <UserAgentString>N/A</UserAgentString>\r\r
      <Endpoint>/adfs/oauth2/token</Endpoint>\r\r
    </Component>\r\r
  </ContextComponents>\r\r
</AuditBase>`,source:`WinEventLog:Security`,host:`myhost.acme.com`,sourcetype:`WinEventLog:Security`,index:`wineventlog`}];export{e as default};