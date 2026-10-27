var e=[{_raw:`{
    "insertId": "XXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXX",
    "labels": {
      "authorization.k8s.io/decision": "allow",
      "authorization.k8s.io/reason": "RBAC: allowed by ClusterRoleBinding \\"system:kube-controller-manager\\" of ClusterRole \\"system:kube-controller-manager\\" to User \\"system:kube-controller-manager\\""
    },
    "logName": "projects/XXXXXXXXX/logs/cloudaudit.googleapis.com%2Factivity",
    "operation": {
      "first": true,
      "id": "XXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXX",
      "last": true,
      "producer": "k8s.io"
    },
    "protoPayload": {
      "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
      "authenticationInfo": {
        "principalEmail": "system:kube-controller-manager"
      },
      "authorizationInfo": [
        {
          "granted": true,
          "permission": "io.k8s.coordination.v1.leases.update",
          "resource": "coordination.k8s.io/v1/namespaces/kube-system/leases/kube-controller-manager"
        }
      ],
      "methodName": "io.k8s.coordination.v1.leases.update",
      "requestMetadata": {
        "callerIp": "XXX.XXX.XXX.XXX",
        "callerSuppliedUserAgent": "kube-controller-manager/v1.32.9 (linux/amd64) kubernetes/f0c9c04/leader-election"
      },
      "resourceName": "coordination.k8s.io/v1/namespaces/kube-system/leases/kube-controller-manager",
      "serviceName": "k8s.io",
      "status": {}
    },
    "receiveTimestamp": "2026-01-20T18:43:58.787949033Z",
    "resource": {
      "labels": {
        "cluster_name": "XXXXXXXXX",
        "location": "us-central1-c",
        "project_id": "XXXXXXXXX"
      },
      "type": "k8s_cluster"
    },
    "timestamp": "2026-01-20T18:43:57.363228Z"
  }`,_time:1773857857.132,cribl_breaker:`Break on newlines`}];export{e as default};