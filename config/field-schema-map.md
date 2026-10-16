# Field Name Reference by Target Schema

Mapping of canonical field concepts to their correct names per output schema.
Use this when generating mappings — field names MUST match the target exactly.

## Network

### src_ip
Raw: SrcIP, srcip, srcaddr, SourceIP (Sentinel/CEF), src_ip (CIM canonical)
- ecs: `source.ip`
- ocsf: `src_endpoint.ip`
- sentinel_cef: `SourceIP`
- vpc_flow_ccs: `__source_ip`

### dest_ip
Raw: DstIP, dstip, dstaddr, DestinationIP (Sentinel/CEF), dest_ip (CIM canonical)
- ecs: `destination.ip`
- ocsf: `dst_endpoint.ip`
- sentinel_cef: `DestinationIP`
- vpc_flow_ccs: `__destination_ip`

### src_port
Raw: SrcPort, srcport
- ecs: `source.port`
- ocsf: `src_endpoint.port`
- sentinel_cef: `SourcePort`
- vpc_flow_ccs: `__source_port`

### dest_port
Raw: DstPort, dstport
- ecs: `destination.port`
- ocsf: `dst_endpoint.port`

### protocol
Raw: Protocol, proto (numeric, needs lookup to name), protocol (VPC flow, numeric), ip_protocol (PAN, numeric, unmapped)
- ecs: `network.transport`
- ocsf: `connection_info.protocol`
- sentinel_cef: `Protocol`
- vpc_flow_ccs: `__network_protocol`
Note: protocol numbers require a lookup (e.g. protocols.csv, ftnt_protocol_info.csv) to derive human-readable transport name

### bytes
Raw: sentbyte/rcvdbyte (FortiGate), bytes (VPC flow)
- cim: `bytes_in / bytes_out / bytes`
- sentinel_cef: `in= / out= (cef_ext only)`

### action
Raw: action/status/utmaction (FortiGate, needs fallback chain to a single 'ftnt_action' key), action (ACCEPT/REJECT, VPC flow), (vendor-specific action word, ASA/FTD)
- cim: `action (via ftnt_action -> CSV lookup)`
- ecs: `event.action`
- ocsf: `activity_name`
- sentinel_cef: `DeviceAction`
- vpc_flow_ccs: `__action / __outcome`

### severity
Raw: level/crlevel/apprisk (FortiGate), cisco_severity (ASA/FTD)
- cim: `severity, severity_id (via ftnt_level -> CSV lookup)`
- ecs: `log.syslog.severity`
- ocsf: `severity_id / severity`
- sentinel_cef: `LogSeverity, LogSeverityLabel (numeric 0-10 + label, own CSV keyed same as CIM's ftnt_level)`

## Identity

### user
Raw: user/unauthuser/xauthuser (FortiGate)
- cim: `user / src_user`
- sentinel_cef: `SourceUserName`

## Meta

### vendor
- cim: `vendor (literal, e.g. 'Fortinet', 'Cisco')`
- ecs: `observer.vendor`
- ocsf: `metadata.product.vendor_name`
- sentinel_cef: `DeviceVendor (CEF header field 2)`

### product
- cim: `product (literal, e.g. 'FortiGate', 'ASA')`
- ecs: `observer.product`
- ocsf: `metadata.product.name`
- sentinel_cef: `DeviceProduct (CEF header field 3)`

### device_name
Raw: devname/devid (FortiGate), dvc_name (Palo Alto)
- cim: `dvc`
- sentinel: `Computer`

### _raw
- ecs: `(fields flattened, no equivalent — nested JSON object)`
- ocsf: `raw_data`

### _time
- ecs: `@timestamp`
- ocsf: `time`
- sentinel: `TimeGenerated (ISO string via C.Time.strftime)`
