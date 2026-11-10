var e=[{_time:1666108026,cribl_breaker:`Break on newlines`,_raw:`10/18/2022 10:47:06 AM
LogName=Application
SourceName=MSSQLSERVER
EventCode=33205
EventType=8
Type=Success Audit
ComputerName=myhost.acme.com
Category=4
CategoryString=Logon\r
RecordNumber=782493343
Message=Audit event: audit_schema_version:1
event_time:2022-10-18 15:47:05.6060126
sequence_number:1
action_id:LGIS
succeeded:true
is_column_permission:false
session_id:119
server_principal_id:362
database_principal_id:0
target_server_principal_id:0
target_database_principal_id:0
object_id:0
user_defined_event_id:0
transaction_id:0
class_type:LX
permission_bitmask:00000000000000000000000000000000
sequence_group_id:ED06C69D-3881-4C34-9C31-0F297B80A55E
session_server_principal_name:DW_Subscription
server_principal_name:DW_Subscription
server_principal_sid:b36c21723a45b64fb7ca9ca28f0ebcbc
database_principal_name:
target_server_principal_name:
target_server_principal_sid:
target_database_principal_name:
server_instance_name:ETCDVSQL032
database_name:
schema_name:
object_name:
statement:-- network protocol: TCP/IP\r
set quoted_identifier on\r
set arithabort off\r
set numeric_roundabort off\r
set ansi_warnings on\r
set ansi_padding on\r
set ansi_nulls on\r
set concat_null_yields_null on\r
set cursor_close_on_commit off\r
set implicit_transactions off\r
set language us_english\r
set dateformat mdy\r
set datefirst 7\r
set transaction isolation level read committed\r

additional_information:<action_info xmlns="http://schemas.microsoft.com/sqlserver/2008/sqlaudit_data"><pooled_connection>1</pooled_connection><client_options>0x28000020</client_options><client_options1>0x0001f438</client_options1><connect_options>0x00000000</connect_options><packet_data_size>8000</packet_data_size><address>10.24.218.88</address><is_dac>0</is_dac></action_info>
user_defined_information:
.`,source:`WinEventLog:Application`,host:`ETCDVSQL032`,sourcetype:`WinEventLog:Application`,index:`oswin_onprem`}];export{e as default};