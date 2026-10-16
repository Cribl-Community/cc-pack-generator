var e=[{_raw:`{
      "alias1": null,
      "alias2": null,
      "alias3": null,
      "alias4": null,
      "aliases": {},
      "created": 1727596523,
      "custom_attributes": {},
      "date_of_birth": null,
      "desktop_authenticators": [],
      "desktoptokens": [],
      "email": "jsmith@example.com",
      "enable_auto_prompt": true,
      "entra_federated_user_id": null,
      "firstname": "John",
      "groups": [
        {
          "desc": "Engineering team members",
          "group_id": "DG1A2B3C4D5E6F7G8H9I",
          "name": "Engineering"
        },
        {
          "desc": "VPN access users",
          "group_id": "DGJ0K1L2M3N4O5P6Q7R8",
          "name": "VPN Users"
        }
      ],
      "is_enrolled": true,
      "last_directory_sync": 1727590000,
      "last_login": 1727596200,
      "lastname": "Smith",
      "lockout_reason": null,
      "notes": "Software engineer - Seattle office",
      "phones": [
        {
          "activated": true,
          "app_version": "4.97.0.1349.1",
          "capabilities": ["auto", "push", "sms"],
          "creation_date": "2024-03-15T10:30:00",
          "encrypted": "Encrypted",
          "extension": "",
          "fingerprint": "Configured",
          "last_activated_date": "2024-03-15T10:35:00",
          "last_seen": "2025-09-29T08:15:23",
          "model": "Apple iPhone 14 Pro",
          "name": "Work Phone",
          "number": "+12065551234",
          "os_version": "17.5.1",
          "phone_id": "DP1A2B3C4D5E6F7G8H9I",
          "platform": "Apple iOS",
          "screenlock": "Locked",
          "sms_passcodes_sent": false,
          "tampered": "Not tampered",
          "type": "Mobile"
        }
      ],
      "realname": "John Smith",
      "status": "active",
      "tokens": [],
      "u2ftokens": [],
      "user_id": "DU2M3N4O5P6Q7R8S9T0U",
      "username": "jsmith",
      "webauthncredentials": [
        {
          "credential_name": "YubiKey 5",
          "date_added": 1720000000,
          "label": "Hardware Security Key",
          "webauthnkey": "WK3B4C5D6E7F8G9H0I1J"
        }
      ]
    }`,_time:1727596523,cribl_breaker:`Duo JSON Logs`},{_raw:`{
      "alias1": "sarah.martinez",
      "alias2": null,
      "alias3": null,
      "alias4": null,
      "aliases": {
        "alias1": "sarah.martinez"
      },
      "created": 1695000000,
      "custom_attributes": {
        "department": "Finance",
        "employee_id": "EMP-5678"
      },
      "date_of_birth": null,
      "desktop_authenticators": [
        {
          "authenticator_id": "DA4C5D6E7F8G9H0I1J2K",
          "name": "Work Laptop",
          "type": "Duo Desktop"
        }
      ],
      "desktoptokens": [],
      "email": "smartinez@example.com",
      "enable_auto_prompt": false,
      "entra_federated_user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "firstname": "Sarah",
      "groups": [
        {
          "desc": "Finance department users",
          "group_id": "DGS1T2U3V4W5X6Y7Z8A9",
          "name": "Finance"
        },
        {
          "desc": "Salesforce application users",
          "group_id": "DGB0C1D2E3F4G5H6I7J8",
          "name": "Salesforce Users"
        }
      ],
      "is_enrolled": true,
      "last_directory_sync": 1727595600,
      "last_login": 1727609253,
      "lastname": "Martinez",
      "lockout_reason": null,
      "notes": "Senior Financial Analyst - requires desktop token for compliance",
      "phones": [
        {
          "activated": true,
          "app_version": "4.96.0.1340.5",
          "capabilities": ["auto", "push", "sms", "phone"],
          "creation_date": "2023-09-15T09:20:00",
          "encrypted": "Encrypted",
          "extension": "",
          "fingerprint": "Configured",
          "last_activated_date": "2023-09-15T09:25:00",
          "last_seen": "2025-09-29T11:47:33",
          "model": "Google Pixel 8",
          "name": "Personal Mobile",
          "number": "+14155559012",
          "os_version": "14",
          "phone_id": "DP5F6G7H8I9J0K1L2M3N",
          "platform": "Google Android",
          "screenlock": "Locked",
          "sms_passcodes_sent": true,
          "tampered": "Not tampered",
          "type": "Mobile"
        }
      ],
      "realname": "Sarah Martinez",
      "status": "active",
      "tokens": [
        {
          "serial": "123456789",
          "token_id": "DHSM1234567890ABCDEF",
          "type": "h6"
        }
      ],
      "u2ftokens": [],
      "user_id": "DU6O7P8Q9R0S1T2U3V4W",
      "username": "smartinez",
      "webauthncredentials": []
    }`,_time:1759172129.363,cribl_breaker:`Duo JSON Logs`}];export{e as default};