var e=[{_raw:`{
        "access_device": {
          "browser": "Chrome",
          "browser_version": "111.0.0.0",
          "epkey": "EP123456789012345678",
          "ip": {
            "address": "172.34.40.116"
          },
          "location": {
            "city": "Ann Arbor",
            "country": "United States",
            "state": "Michigan"
          },
          "os": "Mac OS X",
          "os_version": "10.15.7"
        },
        "action": {
          "details": null,
          "name": "webauthncredential_create"
        },
        "activity_id": "720b8360-078b-47c4-adc7-7968df1caef0",
        "actor": {
          "details": "{\\"created\\": \\"2015-09-25T23:17:40.000000+00:00\\", \\"last_login\\": \\"2023-03-21T19:51:09.000000+00:00\\", \\"status\\": \\"Active\\", \\"groups\\": [{\\"name\\": \\"CorpHQ_Users\\", \\"key\\": \\"DGAZ172QBWDM26AK8ITK\\"}, {\\"name\\": \\"ITAdmins\\", \\"key\\": \\"DGK3B7XTSIP00LKHK1RD\\"}, {\\"name\\": \\"yee\\", \\"key\\": \\"DGKZWSBCDADEVFGFK5NR\\"}]}",
          "key": "DU64TKJPJ0SHFWKO2LNBC",
          "name": "sogilby",
          "type": "user"
        },
        "akey": "DAAR5FO0OZ4VYZA0WOB2",
        "application": {
          "key": "DILSVDEYH66TBHKIXGR9",
          "name": "Acme Corp",
          "type": "websdk"
        },
        "old_target": null,
        "outcome": {
          "result": "FAILURE"
        },
        "target": {
          "details": "{\\"authenticator_type\\": \\"Security key\\", \\"transport_types\\": \\"usb\\", \\"passwordless_authorized\\": false, \\"browser\\": \\"Chrome\\", \\"browser_version\\": \\"111.0.0.0\\", \\"os\\": \\"Mac OS X\\", \\"os_version\\": \\"10.15.7\\", \\"user_agent\\": \\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36\\", \\"credential_name\\": \\"Security key\\"}",
          "key": "WAUKH0IMTGP00L90LT4KM",
          "name": "WAUKH0IMTG3EDD4DT4KM",
          "type": "webauthn_credential"
        },
        "ts": "2023-03-21T15:51:22.591015+00:00"
      }`,_time:1759171896.956,cribl_breaker:`Duo JSON Logs`},{_raw:`{
        "access_device": {
          "browser": "Firefox",
          "browser_version": "128.0",
          "epkey": "EP987654321098765432",
          "ip": {
            "address": "203.0.113.45"
          },
          "location": {
            "city": "Seattle",
            "country": "United States",
            "state": "Washington"
          },
          "os": "Windows",
          "os_version": "11"
        },
        "action": {
          "details": "{\\"role\\": \\"Owner\\"}",
          "name": "admin_create"
        },
        "activity_id": "8a1b2c3d-4e5f-6789-0abc-def123456789",
        "actor": {
          "details": "{\\"created\\": \\"2018-05-12T14:23:18.000000+00:00\\", \\"last_login\\": \\"2025-09-29T10:32:45.000000+00:00\\", \\"status\\": \\"Active\\", \\"groups\\": [{\\"name\\": \\"SuperAdmins\\", \\"key\\": \\"DG1A2B3C4D5E6F7G8H9I\\"}, {\\"name\\": \\"Security_Team\\", \\"key\\": \\"DGJ0K1L2M3N4O5P6Q7R8\\"}]}",
          "key": "DUA1B2C3D4E5F6G7H8I9",
          "name": "admin.johnson",
          "type": "user"
        },
        "akey": "DAB9C8D7E6F5A4B3C2D1",
        "application": {
          "key": "DI9Z8Y7X6W5V4U3T2S1R",
          "name": "Duo Admin Panel",
          "type": "admin_panel"
        },
        "old_target": null,
        "outcome": {
          "result": "SUCCESS"
        },
        "target": {
          "details": "{\\"email\\": \\"newadmin@example.com\\", \\"name\\": \\"Sarah Martinez\\", \\"role\\": \\"Owner\\", \\"status\\": \\"Active\\"}",
          "key": "DU2M3N4O5P6Q7R8S9T0U",
          "name": "smartinez",
          "type": "admin"
        },
        "ts": "2025-09-29T10:35:18.234567+00:00"
      }`,_time:1759171896.956,cribl_breaker:`Duo JSON Logs`}];export{e as default};