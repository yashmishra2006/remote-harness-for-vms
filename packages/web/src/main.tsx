import React from 'react';
import ReactDOM from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import App from './App';
import { StoreProvider } from './store';
import { EscanorProvider } from './escanor/EscanorProvider';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <EscanorProvider>
        <App />
      </EscanorProvider>
    </StoreProvider>
  </React.StrictMode>,
);
