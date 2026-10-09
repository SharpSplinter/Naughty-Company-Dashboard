import React from "react"
import { createRoot } from "react-dom/client"
import { FloorApp } from "./components/floor/floor-app"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloorApp />
  </React.StrictMode>,
)
