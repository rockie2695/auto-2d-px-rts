import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import 'uplot/dist/uPlot.min.css' // uPlot 佈局基礎（.u-wrap 定位、canvas block）——缺它軸/overlay 會飄出容器

import App from './App.tsx'
import './index.css'

const rootElement = document.getElementById('root')

if (rootElement === null) {
  throw new Error('index.html 缺少 #root 容器')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
