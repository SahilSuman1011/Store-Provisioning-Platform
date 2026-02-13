const express = require('express');
const k8s = require('@kubernetes/client-node');
const shell = require('shelljs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

let stats = { created: 0, deleted: 0, failures: 0 };

// Abuse Prevention: Rate Limiting
const rateLimits = new Map(); // IP -> { count, resetTime }
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_STORES_TOTAL = 50; // Prevent cluster resource exhaustion

// Audit Log
const auditLog = (action, details) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${action}: ${JSON.stringify(details)}\n`;
    fs.appendFileSync('audit.log', logEntry);
    console.log(`[AUDIT] ${action}:`, details);
};

// Rate Limiting Middleware
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
        auditLog('RATE_LIMIT_EXCEEDED', { ip: clientIP });
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    
    limit.count++;
    next();
};

app.use(rateLimiter);

app.get('/api/metrics', (req, res) => {
    res.json(stats);
});

// 1. Get all stores with POD-LEVEL readiness check
app.get('/api/stores', async (req, res) => {
    try {
        const nsList = await k8sApi.listNamespace();
        const namespacesData = nsList.body || nsList;
        
        if (!namespacesData || !namespacesData.items) {
            return res.json([]);
        }
        
        const storeNamespaces = namespacesData.items.filter(ns => ns.metadata.name.startsWith('store-'));
        
        const stores = await Promise.all(storeNamespaces.map(async (ns) => {
                const nsName = ns.metadata && ns.metadata.name;
                if (!nsName) {
                    return null;
                }
                
                // Check pod status in this namespace
                try {
                    // K8s client library has bugs, use kubectl directly
                    const podResult = shell.exec(`kubectl get pods -n ${nsName} -o json`, { silent: true });
                    if (podResult.code !== 0) {
                        throw new Error(podResult.stderr);
                    }
                    const podsData = JSON.parse(podResult.stdout);
                    const allReady = podsData && podsData.items && podsData.items.length > 0 && 
                                     podsData.items.every(p => p.status.phase === 'Running' && 
                                                               p.status.containerStatuses &&
                                                               p.status.containerStatuses.every(c => c.ready));
                    
                    return {
                        id: nsName,
                        status: allReady ? 'Ready' : 'Provisioning',
                        url: `http://${nsName}.local.gd`,
                        createdAt: ns.metadata.creationTimestamp
                    };
                } catch (podErr) {
                    return {
                        id: nsName,
                        status: 'Provisioning',
                        url: `http://${nsName}.local.gd`,
                        createdAt: ns.metadata.creationTimestamp
                    };
                }
            }));
        
        // Filter out any null results
        const validStores = stores.filter(s => s !== null);
        res.json(validStores);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Provision with correct Helm flag
app.post('/api/stores', async (req, res) => {
    const { name } = req.body;
    
    const storeId = `store-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    
    // Abuse Prevention: Check total store count
    const countCheck = shell.exec(`kubectl get ns -l kubernetes.io/metadata.name | grep ^store- | wc -l`, { silent: true });
    const currentStoreCount = parseInt(countCheck.stdout.trim()) || 0;
    if (currentStoreCount >= MAX_STORES_TOTAL) {
        auditLog('STORE_LIMIT_EXCEEDED', { requested: storeId, current: currentStoreCount, max: MAX_STORES_TOTAL });
        return res.status(429).json({ error: `Maximum store limit (${MAX_STORES_TOTAL}) reached` });
    }
    
    // Idempotency check: Don't create if exists
    console.log(`[POST /api/stores] Checking if store already exists...`);
    const check = shell.exec(`helm status ${storeId} -n ${storeId}`, { silent: true });
    if (check.code === 0) {
        console.log(`[POST /api/stores] Store ${storeId} already exists!`);
        auditLog('STORE_CREATE_DUPLICATE', { storeId });
        return res.status(400).json({ error: "Store already exists" });
    }
    console.log(`[POST /api/stores] Store doesn't exist, proceeding with creation...`);

    auditLog('STORE_CREATE_START', { storeId, name });

    const valuesPath = path.join(__dirname, '../values-local.yaml');
    const chartPath = path.join(__dirname, '../charts/medusa-store');
    
    console.log(`[POST /api/stores] Values path: ${valuesPath}`);
    console.log(`[POST /api/stores] Chart path: ${chartPath}`);

    const cmd = `helm install ${storeId} ${chartPath} --namespace ${storeId} --create-namespace -f ${valuesPath} --timeout 5m`;
    console.log(`[POST /api/stores] Executing command: ${cmd}`);
    
    shell.exec(cmd, (code, stdout, stderr) => {
        if (code !== 0) {
            stats.failures++;
            auditLog('STORE_CREATE_FAILED', { storeId, code, error: stderr.substring(0, 200) });
            console.error(`[POST /api/stores] Helm install FAILED with code ${code}`);
            console.error(`[POST /api/stores] STDERR: ${stderr}`);
            console.error(`[POST /api/stores] STDOUT: ${stdout}`);
            return res.status(500).json({ error: stderr });
        }
        stats.created++;
        auditLog('STORE_CREATE_SUCCESS', { storeId });
        res.json({ message: "Provisioning started", id: storeId });
    });
});

app.delete('/api/stores/:id', async (req, res) => {
    const id = req.params.id;
    auditLog('STORE_DELETE_START', { storeId: id });
    
    // Delete PVCs first to avoid data persistence issues
    shell.exec(`kubectl delete pvc -n ${id} --all`, { silent: true });
    const result = shell.exec(`helm uninstall ${id} -n ${id} && kubectl delete namespace ${id}`, { silent: true });
    
    if (result.code === 0) {
        stats.deleted++;
        auditLog('STORE_DELETE_SUCCESS', { storeId: id });
        res.json({ message: "Cleanup triggered" });
    } else {
        auditLog('STORE_DELETE_FAILED', { storeId: id, error: result.stderr });
        res.status(500).json({ error: result.stderr });
    }
});

app.listen(3001, '0.0.0.0', () => {
    auditLog('ORCHESTRATOR_START', { port: 3001, host: '0.0.0.0' });
});