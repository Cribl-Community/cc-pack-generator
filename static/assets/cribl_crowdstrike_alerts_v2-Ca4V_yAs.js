var e=[{_raw:`{
   "aggregate_id": "aggind:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:AAAAAAAA-0000-4382-9700-BBBBBBBBBBBB",
   "automated_triage": {
    "can_triage": true,
    "triage_status": "finished",
    "triage_outcome": "inconclusive",
    "is_already_handled": false,
    "triage_explanation": "The detection was labeled as inconclusive because it involves the use of a stale user account, which is a common occurrence that can have both benign and malicious explanations. The account in question, \\"MSCORE,\\" had not been used for a significant period, as indicated by the last password set date in 2017 and the recent successful login in 2025. While the reactivation of a stale account can be a sign of unauthorized access or a compromised account, it can also occur due to legitimate reasons such as an employee returning from a long leave or a system administrator reactivating the account for maintenance purposes. The account lacks admin privileges, reducing the immediate risk, and the login was interactive, suggesting it might have been a legitimate user action. Given these factors, the detection does not provide enough context to definitively classify it as either a true positive or a false positive, leading to an inconclusive verdict.",
    "triage_recommendation": "escalate",
    "recommend_host_containment": false,
    "escalation_priority": 149,
    "advancement_probable": false,
    "advancement_probable_confidence": 20
   },
   "cid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
   "composite_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:ind:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:AAAAAAAA-0000-4382-9700-BBBBBBBBBBBB",
   "confidence": 20,
   "context_timestamp": "2025-09-24T23:58:20.432Z",
   "crawled_timestamp": "2025-09-25T00:03:21.960579281Z",
   "created_timestamp": "2025-09-24T23:59:21.957101448Z",
   "data_domains": [
    "Identity"
   ],
   "description": "A stale user became active",
   "display_name": "Use of stale user account",
   "end_time": "2025-09-24T23:58:20.432Z",
   "falcon_host_link": "https://falcon.us-2.crowdstrike.com/identity-protection/detections/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:ind:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:AAAAAAAA-0000-4382-9700-BBBBBBBBBBBB?_cid=00000000000000000000000000000000",
   "id": "ind:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:AAAAAAAA-0000-4382-9700-BBBBBBBBBBBB",
   "mitre_attack": [
    {
     "pattern_id": 51130,
     "tactic_id": "TA0001",
     "technique_id": "T1078",
     "tactic": "Initial Access",
     "technique": "Valid Accounts"
    }
   ],
   "most_recent_activity_time_stamp": "2025-09-24T23:57:38.629Z",
   "name": "StaleUserAccountUsage",
   "objective": "Gain Access",
   "pattern_id": 51130,
   "poly_id": "BBBBBBBBBBBBBBBBBBBj5UXh7zsYQoeyUA5IhYiXHGmW7QAATiHIVOgBxbH54I2NZysTjlCNE80N0Jmk3bWtn-AAAAAAAA==",
   "preceding_activity_time_stamp": "2025-04-08T19:18:28.786Z",
   "product": "idp",
   "scenario": "suspicious_activity",
   "seconds_to_resolved": 0,
   "seconds_to_triaged": 0,
   "severity": 10,
   "severity_name": "Informational",
   "show_in_ui": true,
   "source_account_domain": "AFOS.IO",
   "source_account_name": "MSCORE",
   "source_account_object_guid": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
   "source_account_object_sid": "S-0-0-00-000000000-000000000-000000000-123456",
   "source_account_sam_account_name": "MSCORE",
   "source_products": [
    "Falcon Identity Protection"
   ],
   "source_vendors": [
    "CrowdStrike"
   ],
   "start_time": "2025-09-24T23:58:20.432Z",
   "status": "new",
   "tactic": "Initial Access",
   "tactic_id": "TA0001",
   "technique": "Valid Accounts",
   "technique_id": "T1078",
   "timestamp": "2025-09-24T23:58:20.512Z",
   "type": "idp-user-endpoint-app-info",
   "updated_timestamp": "2025-09-25T00:03:21.960562979Z",
   "user_name": "MSCORE"
  }`,host:`ip-10-255-9-252`,source:`https://api.us-2.crowdstrike.com/alerts/entities/alerts/v2`,_time:1758758361.957,cribl_breaker:[`Crowdstrike API Ruleset:Crowdstrike_Alerts`,`ndjson`]}];export{e as default};