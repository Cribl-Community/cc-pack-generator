var e=[{_raw:`{
    "OperationName": "logged",
    "Success": true,
    "SourceIp": "XXX.XXX.XXX.XXX",
    "Metadata": {
      "offset": 7915586,
      "eventCreationTime": 1769496323842,
      "eventType": "APIActivityAuditEvent",
      "CustomerIDString": "XXXXXXXXX",
      "version": "1.0"
    },
    "UserId": "",
    "ServiceName": "api_request",
    "UTCTimestamp": 1769496323,
    "Attributes": {
      "sub_component_2": "POST /oauth2/token",
      "user_agent": "Go-http-client/1.1",
      "cid": "XXXXXXXXX",
      "status_code": "201",
      "produces": "application/json",
      "request_path": "/oauth2/token",
      "sub_component_3": "us-1",
      "trace_id": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXX",
      "elapsed_microseconds": "95177",
      "elapsed_time": "95.177995ms",
      "request_content_type": "application/x-www-form-urlencoded",
      "request_uri_length": "13",
      "user_ip": "XXX.XXX.XXX.XXX",
      "consumes": "application/x-www-form-urlencoded,text/html",
      "request_accept": "application/json",
      "request_method": "POST",
      "sub_component_1": "logged",
      "APIClientID": "XXXXXXXXX",
      "received_time": "2026-01-27T06:45:23.747018546Z"
    },
    "Message": "",
    "Source": "api_request",
    "AuditKeyValues": [
      {
        "Key": "trace_id",
        "ValueString": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXX"
      },
      {
        "ValueString": "logged",
        "Key": "sub_component_1"
      },
      {
        "Key": "sub_component_3",
        "ValueString": "us-1"
      },
      {
        "Key": "cid",
        "ValueString": "XXXXXXXXX"
      },
      {
        "Key": "request_path",
        "ValueString": "/oauth2/token"
      },
      {
        "Key": "status_code",
        "ValueString": "201"
      },
      {
        "ValueString": "95.177995ms",
        "Key": "elapsed_time"
      },
      {
        "Key": "elapsed_microseconds",
        "ValueString": "95177"
      },
      {
        "Key": "request_accept",
        "ValueString": "application/json"
      },
      {
        "Key": "request_uri_length",
        "ValueString": "13"
      },
      {
        "Key": "APIClientID",
        "ValueString": "XXXXXXXXX"
      },
      {
        "Key": "produces",
        "ValueString": "application/json"
      },
      {
        "Key": "request_content_type",
        "ValueString": "application/x-www-form-urlencoded"
      },
      {
        "Key": "sub_component_2",
        "ValueString": "POST /oauth2/token"
      },
      {
        "Key": "received_time",
        "ValueString": "2026-01-27T06:45:23.747018546Z"
      },
      {
        "Key": "user_ip",
        "ValueString": "XXX.XXX.XXX.XXX"
      },
      {
        "ValueString": "POST",
        "Key": "request_method"
      },
      {
        "Key": "user_agent",
        "ValueString": "Go-http-client/1.1"
      },
      {
        "Key": "consumes",
        "ValueString": "application/x-www-form-urlencoded,text/html"
      }
    ],
    "UserIp": "XXX.XXX.XXX.XXX"
  }`,_time:1773857434.304,cribl_breaker:`Break on newlines`}];export{e as default};