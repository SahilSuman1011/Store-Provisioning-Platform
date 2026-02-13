import React, { useState, useEffect } from 'react';
import axios from 'axios';

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
      setError("Failed to fetch stores. Is the backend running?");
    }
  };

  useEffect(() => {
    // Separate initial load from polling to satisfy React's effect guidelines
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
    try {
      await axios.delete(`${API_BASE}/stores/${id}`);
      fetchStores();
    } catch {
      setError("Delete failed.");
    }
  };

  return (
    <div style={{ padding: '40px', fontFamily: 'Arial', maxWidth: '1000px', margin: 'auto' }}>
      <h1>Urumi Store Provisioner</h1>
      
      {error && <div style={{ color: 'red', background: '#fee', padding: '10px', marginBottom: '10px' }}>{error}</div>}

      <div style={{ marginBottom: '30px' }}>
        <input 
          value={newName} 
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Store Name (e.g. MyShop)"
          style={{ padding: '10px', width: '250px' }}
        />
        <button 
          onClick={handleCreate} 
          disabled={loading || !newName}
          style={{ padding: '10px 20px', marginLeft: '10px', cursor: 'pointer' }}
        >
          {loading ? 'Provisioning...' : 'Create Store'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
        {stores.map(store => (
          <div key={store.id} style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '8px', position: 'relative' }}>
            <h3 style={{ marginTop: 0 }}>{store.id}</h3>
            <p>Status: <b style={{ color: store.status === 'Ready' ? '#2ecc71' : '#f39c12' }}>{store.status}</b></p>
            <p>
               <a href={store.url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all' }}>
                 {store.url}
               </a>
            </p>
            <button 
              onClick={() => handleDelete(store.id)} 
              style={{ background: '#e74c3c', color: 'white', border: 'none', padding: '8px', borderRadius: '4px', cursor: 'pointer', width: '100%' }}
            >
              Delete Store
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}