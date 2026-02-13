# System Design: Store Provisioning Platform

## Components

1. **React Dashboard**: UI for CRUD operations on stores.
2. **Node.js Orchestrator**: Bridges the UI to the K8s API and Helm binary.
3. **Helm Blueprint**: A parameterized chart defining the Medusa server, PVCs, and Ingress.
4. **Nginx Ingress**: Routes external traffic to isolated namespaces.

## End-to-End Flow

1. User submits name -> Orchestrator validates unique name.
2. Orchestrator executes `helm install` using `values-local.yaml`.
3. Kubernetes creates a **Namespace**, **Secret**, **PVC**, and **Deployment**.
4. The **Readiness Probe** in the Deployment checks `localhost:9000/health`.
5. Once Medusa initializes its SQLite DB on the PVC, the Pod becomes `Ready`.
6. Dashboard polls the Orchestrator, which verifies Pod status and switches status from 'Provisioning' to 'Ready'.

## Production Strategy (Local-to-Prod)

- **Local (Kind)**: Uses `values-local.yaml` with `hostSuffix: local.gd`.
- **Prod (VPS)**: Uses `values-prod.yaml` with `hostSuffix: example.com`. The orchestrator would swap the `-f` flag based on the `NODE_ENV`.
- **Secrets**: In production, secrets would be injected via **External Secrets Operator** or **HashiCorp Vault** instead of plain K8s Secrets.
- **Scaling**: The Orchestrator can scale horizontally. Helm's internal state (stored in K8s Secrets) ensures that any instance can manage any store.

## Failure Handling & Idempotency

- **Conflict Management**: The orchestrator checks for existing Helm releases before initiating a new install to prevent resource conflicts.
- **Atomic Installs**: Helm's `--atomic` flag (optional) or manual cleanup ensures that failed installs don't leave orphaned resources.
- **Cleanup Guarantees**: Deleting a store triggers both `helm uninstall` and `kubectl delete namespace`, ensuring that PersistentVolumes, Secrets, and NetworkPolicies are fully purged.

## Upgrade & Rollback

- Since the platform is Helm-based, store versions can be upgraded by updating the `image` tag in `values.yaml` and running `helm upgrade`.
- If an upgrade fails, `helm rollback` can revert the store to its last known healthy state without data loss, as the database resides on a PersistentVolume.

## VPS Deployment Strategy (k3s)

To migrate this platform from Local (Kind) to a Production VPS:

1. **Infrastructure**: Install k3s on the VPS: \`curl -sfL https://get.k3s.io | sh -\`.
2. **Kubeconfig**: Point the Orchestrator to the VPS kubeconfig at \`/etc/rancher/k3s/k3s.yaml\`.
3. **Storage**: Swap \`values-local.yaml\` for \`values-prod.yaml\` which uses the \`local-path\` storage class (standard in k3s).
4. **DNS**: Configure a Wildcard A Record (\`\*.yourdomain.com\`) pointing to the VPS IP.
5. **TLS**: Add \`cert-manager\` to the cluster and update the Helm Ingress template to include:
   \`\`\`yaml
   annotations:
   cert-manager.io/cluster-issuer: "letsencrypt-prod"
   tls:
   - hosts: [ "{{ .Release.Name }}.yourdomain.com" ]
     secretName: "{{ .Release.Name }}-tls"
     \`\`\`
