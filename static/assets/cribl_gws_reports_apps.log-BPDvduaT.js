var e=[{_raw:`{
      "kind": "admin#reports#activity",
      "id": {
        "time": "2025-10-15T19:30:26.851Z",
        "uniqueQualifier": "3970913979489681016",
        "applicationName": "gemini_in_workspace_apps",
        "customerId": "D03cdmbi0"
      },
      "etag": "\\"6yvc0u1_mWuJiETyootWURYWuYFYgltz9xJKYRsM3cM/scUWhdME5qbFUnBxhMb1JF-x7xc\\"",
      "actor": {
        "callerType": "USER",
        "email": "user@acmecorp.com",
        "profileId": "117329556664445035546"
      },
      "ipAddress": "69.122.43.179",
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
              "value": "gemini_app"
            },
            {
              "name": "feature_source",
              "value": "chat_with_gemini"
            },
            {
              "name": "action",
              "value": "classic_use_case_gemini_app"
            },
            {
              "name": "event_category",
              "value": "active_conversations"
            }
          ]
        }
      ]
    }`,host:`ip-10-255-0-219`,source:`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/gemini_in_workspace_apps`,kind:`admin#reports#activity`,id:{time:`2025-10-15T19:30:26.851Z`,uniqueQualifier:`3970913979489681016`,applicationName:`gemini_in_workspace_apps`,customerId:`D03cdmbi0`},etag:`"6yvc0u1_mWuJiETyootWURYWuYFYgltz9xJKYRsM3cM/scUWhdME5qbFUnBxhMb1JF-x7xc"`,actor:{callerType:`USER`,email:`user@acmecorp.com`,profileId:`117329556664445035546`},ipAddress:`69.122.43.179`,networkInfo:{ipAsn:[701],regionCode:`US`,subdivisionCode:`US-NY`},events:[{type:`ai_usage_event`,name:`feature_utilization`,parameters:[{name:`app_name`,value:`gemini_app`},{name:`feature_source`,value:`chat_with_gemini`},{name:`action`,value:`classic_use_case_gemini_app`},{name:`event_category`,value:`active_conversations`}]}],_time:1760556626.851,_data_source:`http_google_workspace_admin`,cribl_breaker:[`google_sdk:get_items`,`ndjson`]},{_raw:`{
      "kind": "admin#reports#activity",
      "id": {
        "time": "2025-10-15T19:23:36.443Z",
        "uniqueQualifier": "-5863911632630507400",
        "applicationName": "gemini_in_workspace_apps",
        "customerId": "D03cdmbi0"
      },
      "etag": "\\"6yvc0u1_mWuJiETyootWURYWuYFYgltz9xJKYRsM3cM/-yXfQPj321KRfBq7-jgxXvHUnE4\\"",
      "actor": {
        "callerType": "USER",
        "email": "user@acmecorp.com",
        "profileId": "117329556664445035546"
      },
      "ipAddress": "69.122.43.179",
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
    }`,host:`ip-10-255-0-219`,source:`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/gemini_in_workspace_apps`,kind:`admin#reports#activity`,id:{time:`2025-10-15T19:23:36.443Z`,uniqueQualifier:`-5863911632630507400`,applicationName:`gemini_in_workspace_apps`,customerId:`D03cdmbi0`},etag:`"6yvc0u1_mWuJiETyootWURYWuYFYgltz9xJKYRsM3cM/-yXfQPj321KRfBq7-jgxXvHUnE4"`,actor:{callerType:`USER`,email:`user@acmecorp.com`,profileId:`117329556664445035546`},ipAddress:`69.122.43.179`,networkInfo:{ipAsn:[701],regionCode:`US`,subdivisionCode:`US-NY`},events:[{type:`ai_usage_event`,name:`feature_utilization`,parameters:[{name:`app_name`,value:`docs`},{name:`feature_source`,value:`help_me_write`},{name:`action`,value:`generate_document`},{name:`event_category`,value:`active_generate`}]}],_time:1760556216.443,_data_source:`http_google_workspace_admin`,cribl_breaker:[`google_sdk:get_items`,`ndjson`]}];export{e as default};