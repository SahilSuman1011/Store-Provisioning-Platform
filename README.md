# Urumi SDE Assessment - Round 1

## Local Setup

1. `kind create cluster --config kind-config.yaml`
2. `kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml`
3. Wait for Nginx: `kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=90s`
4. Start Backend: `cd orchestrator && node index.js`
5. Start Frontend: `cd dashboard && npm run dev`

## How to Place an Order (Testable Done)

1. Add `127.0.0.1 store-myshop.local.gd` to your Windows hosts file.
2. Open `http://store-myshop.local.gd`.
3. Click on the default "Medusa Sweatshirt".
4. Select a size and "Add to Cart".
5. Click the Cart icon -> Checkout.
6. Enter dummy details (email: test@test.com).
7. Select "Fake Payment" (enabled by default in Medusa starter).
8. Click "Complete Order".
9. **Verification**: Access `http://store-myshop.local.gd/admin` to see the order (Default credentials: admin@medusa-test.com / hello_world).

## Troubleshooting

- **404 Error**: Ensure your Windows `hosts` file includes `127.0.0.1 <store-name>.local.gd`.
- **502 Bad Gateway**: Medusa is still starting. Wait 60 seconds and refresh.
- **View Logs**: To see what Medusa is doing, run:
  `kubectl logs -f deployment/<store-id> -n <store-id>`

## Cleanup

To remove all stores and free up resources:

1. Delete them via the Dashboard.
2. Alternatively, run: `kubectl delete ns -l kubernetes.io/metadata.name=store-*`
