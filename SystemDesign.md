# System Design: Store Provisioning Platform

## Architecture Overview

### Components

1. **React Dashboard**: UI for CRUD operations on stores with real-time status polling.
2. **Node.js Orchestrator**: REST API bridging UI to Kubernetes, handling Helm deployments.
3. **Helm Chart**: Parameterized blueprint for MedusaJS + PostgreSQL + Ingress + RBAC + NetworkPolicy.
4. **Nginx Ingress**: Routes HTTP traffic to store pods via wildcard domain routing.
5. **Kubernetes Control Plane**: Orchestrates pod lifecycle, storage, and networking.

### Technology Stack

| Layer                 | Technology        | Purpose                                        |
| --------------------- | ----------------- | ---------------------------------------------- |
| **Frontend**          | React 19 + Vite   | Dashboard UI with TypeScript support           |
| **Backend**           | Node.js + Express | Orchestrator API with Helm integration         |
| **Container Runtime** | Docker + Kind/k3s | Local development and production clusters      |
| **Orchestration**     | Kubernetes 1.27+  | Multi-tenant isolation and resource management |
| **Package Manager**   | Helm 3            | Declarative deployments with values injection  |
| **Database**          | PostgreSQL 13     | Per-store relational database                  |
| **E-Commerce**        | MedusaJS          | Headless commerce backend with REST APIs       |
| **Networking**        | Nginx Ingress     | HTTP(S) routing with wildcard domains          |

---

## End-to-End Flow

### Store Creation (Happy Path)

```
User → Dashboard → POST /api/stores
  ↓
Orchestrator:
  1. Rate limit check (10 req/min per IP) ✓
  2. Store count check (max 50 stores) ✓
  3. Idempotency check (helm status) ✓
  4. Audit log: STORE_CREATE_START
  5. Execute: helm install <store-id> ./charts/medusa-store \
       --namespace <store-id> \
       --create-namespace \
       -f values-local.yaml \
       --timeout 5m
  ↓
Kubernetes:
  1. Create Namespace with labels
  2. Apply ResourceQuota (2 pods, 500m CPU, 512Mi RAM)
  3. Create NetworkPolicy (deny-by-default, allow from ingress-nginx)
  4. Create ServiceAccount + Role + RoleBinding (RBAC)
  5. Generate Secret with random JWT token
  6. Create Service (ClusterIP on port 9000)
  7. Create Ingress (route *.local.gd to service)
  8. Create Deployment:
     - Init PostgreSQL container (starts in ~10s)
     - Start MedusaJS container (connects to Postgres)
     - MedusaJS runs migrations + seeding (~30-60s)
     - Readiness probe hits /health endpoint
     - Pod status → Running, Ready: 2/2
  ↓
Orchestrator:
  - Audit log: STORE_CREATE_SUCCESS
  - Increment metrics.created
  - Return 200 OK to dashboard
  ↓
Dashboard:
  - Poll GET /api/stores every 5s
  - Fetch pod status via kubectl
  - Display status: Provisioning → Ready
  - Show clickable URL: http://store-<name>.local.gd
```

### Store Deletion (Cleanup Path)

```
User → Dashboard → DELETE /api/stores/<id>
  ↓
Orchestrator:
  1. Audit log: STORE_DELETE_START
  2. Execute: kubectl delete pvc -n <id> --all  # Cleanup data
  3. Execute: helm uninstall <id> -n <id>       # Remove Helm release
  4. Execute: kubectl delete namespace <id>      # Purge namespace
  ↓
Kubernetes:
  1. Terminate all pods gracefully (30s grace period)
  2. Delete Services, Ingress, Secrets
  3. Delete NetworkPolicy, ResourceQuota
  4. Delete RBAC resources (SA, Role, RoleBinding)
  5. Remove namespace (cascading deletion of all resources)
  ↓
Orchestrator:
  - Audit log: STORE_DELETE_SUCCESS
  - Increment metrics.deleted
  - Return 200 OK
```

---

## Production Strategy (Local-to-Prod)

### Key Differences via Helm Values

| Aspect             | **Local (Kind)**       | **Prod (VPS/k3s)**                |
| ------------------ | ---------------------- | --------------------------------- |
| **Ingress Domain** | `*.local.gd`           | `*.yourdomain.com`                |
| **Storage Type**   | `emptyDir` (ephemeral) | `PersistentVolumeClaim`           |
| **Storage Class**  | `standard`             | `local-path` (k3s default)        |
| **Storage Size**   | 1Gi                    | 5Gi                               |
| **TLS**            | None                   | cert-manager + Let's Encrypt      |
| **Secrets Source** | Helm random generation | External Secrets Operator / Vault |
| **Monitoring**     | None                   | Prometheus + Grafana              |

### Storage Strategy

**Helm Template**: [deployment.yaml](charts/medusa-store/templates/deployment.yaml) uses conditional logic:

```yaml
volumes:
  - name: storage
    {{- if .Values.storage.usePVC }}
    persistentVolumeClaim:
      claimName: {{ .Release.Name }}-data
    {{- else }}
    emptyDir: {}  # For local dev/testing only
    {{- end }}
```

**Rationale**:

- **Local Development**: `emptyDir` allows fast iteration without PVC provisioning issues. Data resets on pod restart, which helps test fresh installations.
- **Production**: `usePVC: true` enables real persistence. Database survives pod restarts and node failures.

**Configuration**:

```bash
# Local: Use emptyDir
helm install store-demo ./charts/medusa-store -f values-local.yaml

# Production: Use PVC
helm install store-demo ./charts/medusa-store -f values-prod.yaml
```

---

## System Architecture

### Deployment Flow

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

1. **Infrastructure**: Install k3s on the VPS: `curl -sfL https://get.k3s.io | sh -`.
2. **Kubeconfig**: Point the Orchestrator to the VPS kubeconfig at `/etc/rancher/k3s/k3s.yaml`.
3. **Storage**: Swap `values-local.yaml` for `values-prod.yaml` which uses the `local-path` storage class (standard in k3s).
4. **DNS**: Configure a Wildcard A Record (`*.yourdomain.com`) pointing to the VPS IP.
5. **TLS**: Add `cert-manager` to the cluster and update the Helm Ingress template to include:
   ```yaml
   annotations:
     cert-manager.io/cluster-issuer: "letsencrypt-prod"
   tls:
     - hosts: ["{{ .Release.Name }}.yourdomain.com"]
       secretName: "{{ .Release.Name }}-tls"
   ```

---

## Abuse Prevention & Guardrails

### Implemented Controls

#### 1. Rate Limiting (Per-IP)

**Implementation**: In-memory rate limiter in `orchestrator/index.js`

- **Limit**: 10 requests per minute per IP address
- **Response**: HTTP 429 with retry-after hint
- **Audit**: Logged to `audit.log` with timestamp and IP

**Code**:

```javascript
const rateLimits = new Map(); // IP -> { count, resetTime }
const MAX_REQUESTS_PER_MINUTE = 10;

const rateLimiter = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!rateLimits.has(clientIP)) {
    rateLimits.set(clientIP, { count: 1, resetTime: now + 60000 });
    return next();
  }

  const limit = rateLimits.get(clientIP);
  if (now > limit.resetTime) {
    rateLimits.set(clientIP, { count: 1, resetTime: now + 60000 });
    return next();
  }

  if (limit.count >= MAX_REQUESTS_PER_MINUTE) {
    auditLog("RATE_LIMIT_EXCEEDED", { ip: clientIP });
    return res.status(429).json({
      error: "Too many requests. Please try again later.",
    });
  }

  limit.count++;
  next();
};
```

#### 2. Store Count Limits (Cluster-Wide)

**Implementation**: Pre-creation validation

- **Limit**: 50 stores maximum per cluster
- **Purpose**: Prevent resource exhaustion on control plane
- **Enforcement**: Checked before each `helm install`

**Logic**:

```javascript
const countCheck = shell.exec(
  `kubectl get ns -l kubernetes.io/metadata.name | grep ^store- | wc -l`,
  { silent: true },
);
const currentStoreCount = parseInt(countCheck.stdout.trim()) || 0;

if (currentStoreCount >= MAX_STORES_TOTAL) {
  auditLog("STORE_LIMIT_EXCEEDED", {
    requested: storeId,
    current: currentStoreCount,
    max: MAX_STORES_TOTAL,
  });
  return res.status(429).json({
    error: `Maximum store limit (${MAX_STORES_TOTAL}) reached`,
  });
}
```

#### 3. Provisioning Timeouts

**Implementation**: Helm `--timeout` flag

- **Duration**: 5 minutes
- **Behavior**: Helm automatically rolls back if deployment doesn't complete
- **Command**: `helm install <store> ... --timeout 5m`

#### 4. ResourceQuota (Per-Namespace)

**File**: `charts/medusa-store/templates/guardrails.yaml`

- **Max Pods**: 2 (postgres + medusa only)
- **CPU Request Limit**: 500m total
- **Memory Request Limit**: 512Mi total
- **CPU Limit Cap**: 1 core total
- **Memory Limit Cap**: 1Gi total

**Effect**: Prevents a single store from monopolizing cluster resources.

#### 5. NetworkPolicy (Inter-Store Isolation)

**File**: `charts/medusa-store/templates/guardrails.yaml`

- **Default Stance**: Deny all ingress traffic
- **Allow**: Traffic only from `ingress-nginx` namespace
- **Block**: Store-to-store communication, external egress (unless explicitly allowed)

**Prevents**: Lateral movement, data exfiltration, cross-tenant attacks.

---

## Observability & Monitoring

### 1. Audit Logging

**Location**: `orchestrator/audit.log`  
**Format**: Timestamped JSON entries

**Logged Events**:

- `STORE_CREATE_START`: User initiated provisioning
- `STORE_CREATE_SUCCESS`: Store deployed successfully
- `STORE_CREATE_FAILED`: Provisioning error with details
- `STORE_CREATE_DUPLICATE`: Attempted to create existing store
- `STORE_DELETE_START`: Deletion requested
- `STORE_DELETE_SUCCESS`: Cleanup completed
- `STORE_DELETE_FAILED`: Cleanup error
- `RATE_LIMIT_EXCEEDED`: IP hit rate limit
- `STORE_LIMIT_EXCEEDED`: Cluster at capacity

**Example Entries**:

```
[2026-02-14T01:23:45.678Z] STORE_CREATE_START: {"storeId":"store-myshop","name":"myshop"}
[2026-02-14T01:24:12.345Z] STORE_CREATE_SUCCESS: {"storeId":"store-myshop"}
[2026-02-14T01:30:00.123Z] RATE_LIMIT_EXCEEDED: {"ip":"192.168.1.100"}
```

### 2. Metrics Endpoint

**URL**: `GET /api/metrics`  
**Response**:

```json
{
  "created": 25,
  "deleted": 10,
  "failures": 3
}
```

**Future Enhancements**:

- Export to Prometheus with `/metrics` endpoint
- Add provisioning duration histogram
- Track concurrent store count
- Monitor Helm operation latency

### 3. Kubernetes Events

**View store events**:

```bash
kubectl get events -n store-myshop --sort-by='.lastTimestamp'
```

**Monitor pod restarts**:

```bash
kubectl get pods -n store-myshop -o json | \
  jq '.items[].status.containerStatuses[] |
      select(.restartCount > 0) |
      {name: .name, restarts: .restartCount}'
```

### 4. Dashboard Status Polling

- **Frequency**: Every 5 seconds
- **Endpoint**: `GET /api/stores`
- **Enrichment**: Calls `kubectl get pods -n <store> -o json` to fetch readiness
- **UI Indicators**:
  - 🟢 **Ready**: All pods running, containers ready
  - 🟠 **Provisioning**: Pods starting or not all ready
  - 🔴 **Failed**: No pods found or crashlooping

---

## Horizontal Scaling Strategy

### Stateless Components (Easily Scalable)

#### 1. Orchestrator API

**Current State**: Single instance  
**Scaling Path**:

```yaml
# orchestrator-deployment.yaml (future)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orchestrator
  namespace: platform
spec:
  replicas: 3 # Scale to 3 instances
  selector:
    matchLabels:
      app: orchestrator
  template:
    metadata:
      labels:
        app: orchestrator
    spec:
      containers:
        - name: orchestrator
          image: orchestrator:1.0
          env:
            - name: KUBECONFIG
              value: /var/run/secrets/kubernetes.io/serviceaccount/token
```

**Considerations**:

- **Helm State**: Shared via Kubernetes Secrets (no local state required)
- **Audit Log**: Move from local file to centralized logging (Loki/Elasticsearch)
- **Rate Limiting**: Replace in-memory Map with Redis for distributed rate limits
- **Load Balancing**: Use Kubernetes Service with round-robin or least-connections

#### 2. Dashboard (Already Stateless)

**Current**: Vite dev server (local only)  
**Production Deployment**:

```bash
# Build static assets
npm run build

# Deploy to CDN (Cloudflare Pages, Vercel, Netlify)
# OR serve from Nginx with high cache headers
```

**Scaling**: Handled by CDN edge locations or Nginx instances behind load balancer.

### Stateful Components (Careful Scaling Required)

#### 3. MedusaJS Store Pods

**Current**: 1 replica per store (postgres + medusa sidecar)  
**Horizontally Scalable With**:

1. **Shared Redis** (for session storage)
   ```yaml
   # Add to deployment.yaml
   - name: REDIS_URL
     value: "redis://redis-service:6379"
   ```
2. **External PostgreSQL** (not sidecar)

   ```yaml
   # Use managed Postgres (RDS, Cloud SQL)
   - name: DATABASE_URL
     valueFrom:
       secretKeyRef:
         name: postgres-connection
         key: url
   ```

3. **Replicas**:
   ```yaml
   spec:
     replicas: 3 # Multiple MedusaJS instances
   ```

**Result**: Load-balanced API requests, but requires:

- Session affinity for admin panel (sticky sessions)
- Distributed file storage (S3) for product images
- Connection pooling (PgBouncer) for database

### Provisioning Throughput Scaling

**Current Limitation**: Sequential Helm installs  
**Bottleneck**: Each store creation blocks orchestrator thread

**Solution**: Job Queue + Worker Pool

```javascript
// Use BullMQ or similar
const Queue = require("bull");
const storeQueue = new Queue("store-provisioning", {
  redis: { host: "redis", port: 6379 },
});

// API endpoint adds to queue
app.post("/api/stores", async (req, res) => {
  const job = await storeQueue.add({
    storeId: req.body.name,
    valuesFile: "values-local.yaml",
  });
  res.json({ jobId: job.id });
});

// Worker processes jobs concurrently
storeQueue.process(5, async (job) => {
  // 5 concurrent workers
  const { storeId, valuesFile } = job.data;
  return shell.exec(`helm install ${storeId} ... -f ${valuesFile}`);
});
```

**Benefits**:

- 5 stores can provision concurrently
- Failed jobs auto-retry with exponential backoff
- Job status queryable by ID
- Scales workers independently of API

---

## Security Posture

### 1. Secret Management

✅ **Helm-Generated Secrets**: Each store gets unique JWT token via `{{ randAlphaNum 32 | b64enc }}`  
⚠️ **PostgreSQL Credentials**: Currently hardcoded (`medusa/medusa`). Production should use:

- Kubernetes Secrets with strong random passwords
- External Secrets Operator + Vault
- Managed database with IAM authentication

### 2. RBAC (Least Privilege)

✅ **Per-Store ServiceAccount**: Pods run with dedicated SA  
✅ **Namespaced Role**: Only access to own namespace resources  
✅ **Explicit Permissions**: `get, list, watch, create, update, patch, delete` on `pods, services, secrets`  
❌ **Admin-Level Access**: No cluster-wide or cross-namespace permissions

**File**: `charts/medusa-store/templates/rbac.yaml`

### 3. Network Isolation

✅ **NetworkPolicy Deny-By-Default**: Pods can't initiate connections  
✅ **Ingress Whitelist**: Only accept traffic from `ingress-nginx` namespace  
❌ **Egress Control**: Not currently restricted (would need DNS/external API whitelist)

### 4. Container Security

⚠️ **Running as Root**: PostgreSQL and MedusaJS containers don't specify `securityContext`  
**Recommended**:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

### 5. API Security

✅ **Rate Limiting**: Prevents brute force and DoS  
✅ **CORS Enabled**: Dashboard can call API cross-origin  
❌ **Authentication**: No user login system (future: JWT tokens, API keys)  
❌ **Authorization**: No per-user store ownership (future: multi-tenancy)

---

## Trade-offs & Design Decisions

### 1. emptyDir vs PersistentVolumeClaim

**Current**: Using `emptyDir` for database storage  
**Reason**: Fixed CrashLoopBackOff issue with duplicate admin user seeding  
**Cons**: Data lost on pod restart  
**Production Fix**: Use PVC with init container to handle idempotent seeding

### 2. Sidecar PostgreSQL vs External Database

**Current**: PostgreSQL as sidecar container  
**Pros**: Simple deployment, no external dependencies  
**Cons**: Can't scale MedusaJS independently, limited to single pod  
**Production**: Use managed Postgres (RDS/Cloud SQL) for HA and backups

### 3. Kubectl Shell Commands vs Kubernetes API Client

**Current**: Using `shell.exec('kubectl ...')` for pod status  
**Reason**: `@kubernetes/client-node` library had parameter binding bugs  
**Cons**: Shell overhead, parsing JSON output  
**Future**: Fix Kubernetes client or use official Go client wrapper

### 4. In-Memory Rate Limiting vs Redis

**Current**: JavaScript Map storing per-IP counters  
**Pros**: Zero dependencies, fast  
**Cons**: Not shared across orchestrator replicas, lost on restart  
**Production**: Redis-backed rate limiter for distributed systems

### 5. Audit Log Files vs Centralized Logging

**Current**: Appending to `audit.log` file  
**Pros**: Simple, no infrastructure needed  
**Cons**: Not queryable, no aggregation, lost if pod deleted  
**Production**: Stream to Loki/Elasticsearch with structured logging

---

## Future Enhancements

1. **Multi-User Support**: User authentication + store ownership
2. **Store Templates**: Predefined product catalogs (fashion, electronics, etc.)
3. **Backup/Restore**: Automated PostgreSQL backups to S3
4. **Monitoring Dashboards**: Grafana visualizing Prometheus metrics
5. **Auto-Healing**: Detect crashlooping stores and auto-recreate
6. **Cost Tracking**: Per-store resource usage and billing
7. **CI/CD Integration**: GitOps workflow with ArgoCD
8. **WooCommerce Support**: Add second chart for WordPress stores
