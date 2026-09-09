import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReminderPopup } from './ReminderPopup'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReminderPopup />
  </StrictMode>,
)
