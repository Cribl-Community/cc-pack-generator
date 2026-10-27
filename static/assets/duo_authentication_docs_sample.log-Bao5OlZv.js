var e=[{_raw:`{
                "access_device": {
                    "browser": "Chrome",
                    "browser_version": "128.0.6613.84",
                    "epkey": "EP2M5N8Q1R4T7V0X3Y6Z",
                    "flash_version": "uninstalled",
                    "hostname": null,
                    "ip": "192.168.1.105",
                    "is_encryption_enabled": true,
                    "is_firewall_enabled": true,
                    "is_password_set": true,
                    "java_version": "uninstalled",
                    "location": {
                        "city": "Boston",
                        "country": "United States",
                        "state": "Massachusetts"
                    },
                    "os": "Mac OS X",
                    "os_version": "14.5",
                    "security_agents": []
                },
                "adaptive_trust_assessments": {
                    "more_secure_auth": {
                        "detected_attack_detectors": [],
                        "features_version": "3.0",
                        "model_version": "2024.08.15.001",
                        "policy_enabled": true,
                        "reason": "Normal trust level",
                        "trust_level": "NORMAL"
                    },
                    "remember_me": {
                        "features_version": "3.0",
                        "model_version": "2024.08.15.001",
                        "policy_enabled": true,
                        "reason": "Known Access IP",
                        "trust_level": "NORMAL"
                    }
                },
                "alias": "",
                "application": {
                    "key": "DI4Q7T0V3X6Z9C2F5H8K",
                    "name": "GitHub Enterprise"
                },
                "auth_device": {
                    "ip": "10.20.30.78",
                    "key": "DP8X1Z4C7F0H3K6M9P2R",
                    "location": {
                        "city": "Boston",
                        "country": "United States",
                        "state": "Massachusetts"
                    },
                    "name": "iPhone 14 Pro (617-555-3421)"
                },
                "email": "mjackson@example.com",
                "event_type": "authentication",
                "factor": "duo_push",
                "isotimestamp": "2025-09-29T09:15:42.123456+00:00",
                "ood_software": null,
                "passport_assessment": {
                    "is_supported": false,
                    "reason": "absent_health_report"
                },
                "reason": "user_approved",
                "result": "success",
                "timestamp": 1727600142,
                "trusted_endpoint_status": "trusted",
                "trusted_session_info": {
                    "trusted_session_uuid": "a1b2c3d4-e5f6-4789-0abc-def123456789"
                },
                "txid": "c5d6e7f8-g901-4h23-i456-j789k012l345",
                "user": {
                    "groups": [
                        "Engineering",
                        "GitHub Users"
                    ],
                    "key": "DU5AB6CD7EF8GH9IJ0KL",
                    "name": "mjackson@example.com"
                }
            }`,_time:1759171046.949,cribl_breaker:`Duo JSON Logs`},{_raw:`{
                "access_device": {
                    "browser": "Safari",
                    "browser_version": "17.5",
                    "epkey": "EP6K9M2P5R8T1V4X7Z0B",
                    "flash_version": "uninstalled",
                    "hostname": null,
                    "ip": "198.51.100.89",
                    "is_encryption_enabled": true,
                    "is_firewall_enabled": false,
                    "is_password_set": true,
                    "java_version": "uninstalled",
                    "location": {
                        "city": "London",
                        "country": "United Kingdom",
                        "state": "England"
                    },
                    "os": "Windows",
                    "os_version": "10",
                    "security_agents": []
                },
                "adaptive_trust_assessments": {
                    "more_secure_auth": {
                        "detected_attack_detectors": [
                            "ANOMALOUS_LOCATION"
                        ],
                        "features_version": "3.0",
                        "model_version": "2024.08.15.001",
                        "policy_enabled": true,
                        "reason": "Low level of trust; anomalous location detected",
                        "trust_level": "LOW"
                    },
                    "remember_me": {
                        "features_version": "3.0",
                        "model_version": "2024.08.15.001",
                        "policy_enabled": false,
                        "reason": "Unknown Access IP and location",
                        "trust_level": "LOW"
                    }
                },
                "alias": "",
                "application": {
                    "key": "DI9H2K5M8P1R4T7V0X3Z",
                    "name": "Office 365"
                },
                "auth_device": {
                    "ip": "192.0.2.134",
                    "key": "DP1M4P7R0T3V6X9Z2C5F",
                    "location": {
                        "city": "San Francisco",
                        "country": "United States",
                        "state": "California"
                    },
                    "name": "Google Pixel 8 (415-555-9012)"
                },
                "email": "rchen@example.com",
                "event_type": "authentication",
                "factor": "duo_push",
                "isotimestamp": "2025-09-29T11:47:33.789012+00:00",
                "ood_software": null,
                "passport_assessment": {
                    "is_supported": false,
                    "reason": "absent_health_report"
                },
                "reason": "user_denied",
                "result": "denied",
                "timestamp": 1727609253,
                "trusted_endpoint_status": "not trusted",
                "trusted_session_info": null,
                "txid": "d7e8f9g0-h123-4i45-j678-k901l234m567",
                "user": {
                    "groups": [
                        "Marketing",
                        "Office365 Users"
                    ],
                    "key": "DU9GH0IJ1KL2MN3OP4QR",
                    "name": "rchen@example.com"
                }
            }`,_time:1759171046.95,cribl_breaker:`Duo JSON Logs`}];export{e as default};