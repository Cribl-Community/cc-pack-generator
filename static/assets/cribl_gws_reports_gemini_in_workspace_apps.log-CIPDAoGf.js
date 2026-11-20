var e=[{_raw:`{
      "kind": "admin#reports#activity",
      "id": {
        "time": "2025-10-15T19:23:36.443Z",
        "uniqueQualifier": "-5863911632630507400",
        "applicationName": "gemini_in_workspace_apps",
        "customerId": "C02cfmbi9"
      },
      "etag": "\\"yp-tnS_tLI5vIIYY7LEBZ0akzFI7Qz9C60C9F6j9LXI/-yXfQPj321KRfBq7-jgxXvHUnE4\\"",
      "actor": {
        "callerType": "USER",
        "email": "user@acmecorp.com",
        "profileId": "117297378964482035545"
      },
      "ipAddress": "69.131.62.129",
      "networkInfo": {
        "ipAsn": [
          701
        ],
        "regionCode": "US",
        "subdivisionCode": "US-NY"
      },
      "events": [
        {
          "type": "ai_usage_event",
          "name": "feature_utilization",
          "parameters": [
            {
              "name": "app_name",
              "value": "docs"
            },
            {
              "name": "feature_source",
              "value": "help_me_write"
            },
            {
              "name": "action",
              "value": "generate_document"
            },
            {
              "name": "event_category",
              "value": "active_generate"
            }
          ]
        }
      ]
    }`,host:`ip-10-255-9-252`,source:`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/gemini_in_workspace_apps`,kind:`admin#reports#activity`,id:{time:`2025-10-15T19:23:36.443Z`,uniqueQualifier:`-5863911632630507400`,applicationName:`gemini_in_workspace_apps`,customerId:`C02cfmbi9`},etag:`"yp-tnS_tLI5vIIYY7LEBZ0akzFI7Qz9C60C9F6j9LXI/-yXfQPj321KRfBq7-jgxXvHUnE4"`,actor:{callerType:`USER`,email:`user@acmecorp.com`,profileId:`117297378964482035545`},ipAddress:`69.131.62.129`,networkInfo:{ipAsn:[701],regionCode:`US`,subdivisionCode:`US-NY`},events:[{type:`ai_usage_event`,name:`feature_utilization`,parameters:[{name:`app_name`,value:`docs`},{name:`feature_source`,value:`help_me_write`},{name:`action`,value:`generate_document`},{name:`event_category`,value:`active_generate`}]}],_time:1760556216.443,_data_source:`http_google_workspace_admin`,cribl_breaker:[`google_sdk:get_items`,`ndjson`]}];export{e as default};