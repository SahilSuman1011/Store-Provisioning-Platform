import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'http://localhost:3001/api';

export default function App() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState(null);

  const fetchStores = async () => {
    try {
      const res = await axios.get(`${API_BASE}/stores`);
      setStores(res.data);
      setError(null);
    } catch {
      setError("Failed to fetch stores. Is the orchestrator backend running on port 3001?");
    }
  };

  useEffect(() => {
    let isMounted = true;
    
    const loadStores = async () => {
      if (isMounted) await fetchStores();
    };
    
    loadStores();
    const interval = setInterval(fetchStores, 5000);
    
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    
    setLoading(true);
    setError(null);
    try {
      await axios.post(`${API_BASE}/stores`, { name: newName });
      setNewName('');
      fetchStores();
    } catch (err) {
      setError(err.response?.data?.error || "Error creating store");
    }
    setLoading(false);
  };

  const handleDelete = async (id) => {
    if (!confirm(`Delete store "${id}"? This will remove all resources.`)) return;
    
    try {
      await axios.delete(`${API_BASE}/stores/${id}`);
      fetchStores();
    } catch (err) {
      setError(err.response?.data?.error || "Delete failed");
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && newName.trim() && !loading) {
      handleCreate();
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">⚡ Urumi Store Provisioner</h1>
        <p className="app-subtitle">Multi-tenant Kubernetes e-commerce platform</p>
      </header>

      {error && (
        <div className="error-banner">
          <span className="error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <section className="create-section">
        <div className="create-form">
          <div className="input-wrapper">
            <input 
              className="store-input"
              value={newName} 
              onChange={(e) => setNewName(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Enter store name (e.g., myshop, store123)"
              disabled={loading}
            />
          </div>
          <button 
            className="btn btn-primary"
            onClick={handleCreate} 
            disabled={loading || !newName.trim()}
          >
            {loading ? (
              <>
                <span className="loading-spinner"></span>
                Provisioning...
              </>
            ) : (
              <>
                <span>🚀</span>
                Create Store
              </>
            )}
          </button>
        </div>
      </section>

      {stores.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📦</div>
          <h2 className="empty-title">No stores yet</h2>
          <p className="empty-text">Create your first store to get started with the platform</p>
        </div>
      ) : (
        <div className="stores-grid">
          {stores.map(store => (
            <div key={store.id} className="store-card">
              <div className="store-header">
                <h3 className="store-id">{store.id}</h3>
                <span className={`store-status ${store.status === 'Ready' ? 'status-ready' : 'status-provisioning'}`}>
                  <span className="status-dot"></span>
                  {store.status}
                </span>
              </div>
              
              <div className="store-url">
                <a href={store.url} target="_blank" rel="noopener noreferrer">
                  <span>🔗</span>
                  {store.url}
                </a>
              </div>

              <div className="store-footer">
                <button 
                  className="btn btn-danger"
                  onClick={() => handleDelete(store.id)}
                >
                  🗑️ Delete Store
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}