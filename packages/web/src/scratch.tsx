// Scratch entry for verifying the Computers UI in a browser. Not committed.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import ComputersView from './escanor/computer/ComputersView';
createRoot(document.getElementById('root')!).render(<ComputersView />);
