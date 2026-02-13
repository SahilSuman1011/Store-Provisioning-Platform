const express = require('express');
const k8s = require('@kubernetes/client-node');
const shell = require('shelljs');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

let stats = { created: 0, deleted: 0, failures: 0 };

app.get('/api/metrics', (req, res) => {
    res.json(stats);
});

// 1. Get all stores with POD-LEVEL readiness check
app.get('/api/stores', async (req, res) => {
    try {
        const nsList = await k8sApi.listNamespace();
        const stores = await Promise.all(nsList.body.items
            .filter(ns => ns.metadata.name.startsWith('store-'))
            .map(async (ns) => {
                const nsName = ns.metadata.name;
                // Check pod status in this namespace
                const podList = await k8sApi.listNamespacedPod(nsName);
                const allReady = podList.body.items.length > 0 && 
                                 podList.body.items.every(p => p.status.phase === 'Running');
                
                return {
                    id: nsName,
                    status: allReady ? 'Ready' : 'Provisioning',
                    url: `http://${nsName}.local.gd`,
                    createdAt: ns.metadata.creationTimestamp
                };
            }));
        res.json(stores);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Provision with correct Helm flag
app.post('/api/stores', async (req, res) => {
    const { name } = req.body;
    const storeId = `store-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    
    // Idempotency check: Don't create if exists
    const check = shell.exec(`helm status ${storeId} -n ${storeId}`, { silent: true });
    if (check.code === 0) return res.status(400).json({ error: "Store already exists" });

    const valuesPath = path.join(__dirname, '../values-local.yaml');
    const chartPath = path.join(__dirname, '../charts/medusa-store');

    const cmd = `helm install ${storeId} ${chartPath} --namespace ${storeId} --create-namespace -f ${valuesPath}`;
    
    shell.exec(cmd, (code, stdout, stderr) => {
        if (code !== 0) {
            stats.failures++;
            return res.status(500).json({ error: stderr });
        }
        stats.created++;
        res.json({ message: "Provisioning started", id: storeId });
    });
});

app.delete('/api/stores/:id', (req, res) => {
    const id = req.params.id;
    shell.exec(`helm uninstall ${id} -n ${id} && kubectl delete namespace ${id}`);
    stats.deleted++;
    res.json({ message: "Cleanup triggered" });
});

app.listen(3001, () => console.log('Orchestrator online on 3001'));