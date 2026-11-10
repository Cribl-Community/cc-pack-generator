var e=[{_raw:`{
      "_id": "1657c5566973139b27357a8e23cf3a8703c4bca68ce210595e62a5dbdce7631c",
      "access_method": "Client",
      "acting_user": "leeroy.jenkins@test.com",
      "activity": "Download",
      "app": "Microsoft OneDrive",
      "app_session_id": 3483912176895852000,
      "assignee": "None",
      "connection_id": 2762431970988418600,
      "dlp_incident_id": 837324741664663800,
      "dlp_match_info": [
        {
          "dlp_action": "allow",
          "dlp_forensic_id": 837324741664663800,
          "dlp_policy": "DLP PCI Alert",
          "dlp_profile_name": "Payment Card Industry Data Security Standard. PCI-DSS",
          "dlp_rules": [
            {
              "dlp_data_identifiers": {
                "numbers/payment_card_number_terms/eng": 14375,
                "numbers/payment_card_numbers/major": 14375,
                "persons/proper_names/int/full": 14375
              },
              "dlp_incident_rule_count": 14375,
              "dlp_rule_name": "INTL-PAN-Name",
              "dlp_rule_score": 44563,
              "dlp_rule_severity": "Critical",
              "is_unique_count": false,
              "weighted": false
            }
          ]
        },
        {
          "dlp_action": "allow",
          "dlp_forensic_id": 837324741664663800,
          "dlp_policy": "DLP PCI Alert",
          "dlp_profile_name": "DLP-PCI",
          "dlp_rules": [
            {
              "dlp_data_identifiers": {
                "numbers/payment_card_number_terms/eng": 179687,
                "numbers/payment_card_numbers/major": 179687,
                "persons/proper_names/us/last": 179687
              },
              "dlp_incident_rule_count": 179687,
              "dlp_rule_name": "Name-Credit Card (CC)",
              "dlp_rule_score": 556311,
              "dlp_rule_severity": "Critical",
              "is_unique_count": false,
              "weighted": false
            }
          ]
        }
      ],
      "dlp_parent_id": 837324741664663800,
      "dst_location": "Redmond",
      "file_lang": "ENGLISH",
      "file_size": 10256549,
      "file_type": "text/plain",
      "md5": "2f6df9969215d9eb4d266dd636337da7",
      "object_id": "hash_leeroy.jenkins@test.com_2f6df9969215d9eb4d266dd636337da7_1629a7e222524c487c6d8b1dba7f4f98b3d1557d",
      "object_type": "File",
      "severity": "Critical",
      "site": "Microsoft OneDrive",
      "src_location": "San Diego",
      "status": "new",
      "timestamp": 1703111543,
      "title": "hash_leeroy.jenkins@test.com_2f6df9969215d9eb4d266dd636337da7_1629a7e222524c487c6d8b1dba7f4f98b3d1557d",
      "true_obj_category": "Text",
      "true_obj_type": "Plain Text file",
      "url": "ahokbw.sn.files.1drv.com/y4pc8aBlHkeYewYjiXtXi8MYtOs86JJQqo7vg06SX0nKC7Vs3fzqIm5HZ1tF9qKUEmxwCvk-giW-jamW9OmRBUBUbc6nKoArJT-sTdqHY0MSqbenjH6MMv-Vq9TuwHYk34oEgAp3KBd_iy9PlNlQnH5Q5s8Kyirfb4J_uHfMJb74q5dVjeiVOiTvm6Bg1in49q-2xYBGMcsgjhJDHfTFC8-FayiqnePYKvvK2UOvOAZI0c",
      "user": "leeroy.jenkins@test.com",
      "classification": "",
      "latest_incident_id": 0,
      "inline_dlp_match_info": [],
      "from_user": "",
      "destination_site": "",
      "bcc": "",
      "object": "",
      "instance": "",
      "exposure": "",
      "original_file_snapshot_id": "",
      "channel": "",
      "cc": "",
      "instance_id": "",
      "zip_file_id": "",
      "destination_app": "",
      "file_path": "",
      "owner": "",
      "owner_pdl": "",
      "to_user": "",
      "destination_instance_id": "",
      "user_id": "",
      "referer": "",
      "dlp_file": ""
    }`,_time:1703111543,cribl_breaker:`netskope`},{_raw:`{
      "_id": "07c703cd9b3e2185d00aa66c59e7b600ba0f4b8980307edaac2b9a4a322939eb",
      "access_method": "Client",
      "acting_user": "leeroy.jenkins@test.com",
      "activity": "Download",
      "app": "Microsoft OneDrive",
      "app_session_id": 3483912176895852000,
      "assignee": "None",
      "connection_id": 2762431970988418600,
      "dlp_incident_id": 4233141258481958000,
      "dlp_match_info": [
        {
          "dlp_action": "alert",
          "dlp_forensic_id": 837324741664663800,
          "dlp_policy": "DLP PCI Alert",
          "dlp_profile_name": "Payment Card Industry Data Security Standard. PCI-DSS",
          "dlp_rules": [
            {
              "dlp_data_identifiers": {
                "numbers/payment_card_number_terms/eng": 14375,
                "numbers/payment_card_numbers/major": 14375,
                "persons/proper_names/int/full": 14375
              },
              "dlp_incident_rule_count": 14375,
              "dlp_rule_name": "INTL-PAN-Name",
              "dlp_rule_score": 44563,
              "dlp_rule_severity": "Critical",
              "is_unique_count": false,
              "weighted": false
            }
          ]
        },
        {
          "dlp_action": "alert",
          "dlp_forensic_id": 837324741664663800,
          "dlp_policy": "DLP PCI Alert",
          "dlp_profile_name": "DLP-PCI",
          "dlp_rules": [
            {
              "dlp_data_identifiers": {
                "numbers/payment_card_number_terms/eng": 179687,
                "numbers/payment_card_numbers/major": 179687,
                "persons/proper_names/us/last": 179687
              },
              "dlp_incident_rule_count": 179687,
              "dlp_rule_name": "Name-Credit Card (CC)",
              "dlp_rule_score": 556311,
              "dlp_rule_severity": "Critical",
              "is_unique_count": false,
              "weighted": false
            }
          ]
        }
      ],
      "dlp_parent_id": 4233141258481958000,
      "dst_location": "Redmond",
      "file_lang": "ENGLISH",
      "file_size": 10256549,
      "file_type": "text/plain",
      "md5": "2f6df9969215d9eb4d266dd636337da7",
      "object": "credit_cards.12.db",
      "object_id": "hash_leeroy.jenkins@test.com_2f6df9969215d9eb4d266dd636337da7_1629a7e222524c487c6d8b1dba7f4f98b3d1557d",
      "object_type": "File",
      "severity": "Critical",
      "site": "Microsoft OneDrive",
      "src_location": "San Diego",
      "status": "new",
      "timestamp": 1703111613,
      "title": "credit_cards.12.db",
      "true_obj_category": "Text",
      "true_obj_type": "Plain Text file",
      "url": "ahokbw.sn.files.1drv.com/y4pjpgKTqpQltjYaPUVp8c4C7k1RPR1Ijs-eXlAB_BFH3Q8q0wANMEsWuGk5OB2MrAexKOYas2VLGzl-DRmyayHFQXeVXJlS1ggc-PMzlmVRMWdTSzFI5SjNfTU2xMf-MvDOgrJ9W5H5RMnE1tpvWID3sI6OG_6pjRVspm4ugkYPDFSx9H4R-FrsalyUD29u698OVdP929_uQdf9zgpu5Xm5UYQXny6kTuf0MlRGSCnZ9k",
      "user": "leeroy.jenkins@test.com",
      "classification": "",
      "latest_incident_id": 0,
      "inline_dlp_match_info": [],
      "from_user": "",
      "destination_site": "",
      "bcc": "",
      "instance": "",
      "exposure": "",
      "original_file_snapshot_id": "",
      "channel": "",
      "cc": "",
      "instance_id": "",
      "zip_file_id": "",
      "destination_app": "",
      "file_path": "",
      "owner": "",
      "owner_pdl": "",
      "to_user": "",
      "destination_instance_id": "",
      "user_id": "",
      "referer": "",
      "dlp_file": ""
    }`,_time:1703111613,cribl_breaker:`netskope`}];export{e as default};