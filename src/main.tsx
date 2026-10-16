import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './design-tokens.css'
import './App.css'
import './redesign.css'
import './batch-redesign.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
