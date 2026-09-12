import React from 'react';
import {createRoot} from 'react-dom/client';
import Dashboard from '../app/dashboard';
import '../app/globals.css';
import '../app/dashboard.css';
import '../app/readability.css';
createRoot(document.getElementById('root')!).render(<Dashboard/>);
