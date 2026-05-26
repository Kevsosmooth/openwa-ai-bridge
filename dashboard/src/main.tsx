import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.tsx'

// Polyfill crypto.randomUUID for non-secure contexts (plain-HTTP LAN access).
// Browsers expose it only over HTTPS or on localhost; this fallback uses the
// always-available crypto.getRandomValues so the dashboard works over http://<lan-ip>.
{
  const c = crypto as unknown as {
    randomUUID?: () => string
    getRandomValues: Crypto['getRandomValues']
  }
  if (typeof c.randomUUID !== 'function') {
    c.randomUUID = () =>
      '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (ch) =>
        (
          Number(ch) ^
          (c.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(ch) / 4)))
        ).toString(16),
      )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
