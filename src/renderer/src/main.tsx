import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import { init } from './actions'

createRoot(document.getElementById('root')!).render(<App />)
init()
