import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import { App } from "./App";
import { instalaInterceptorDeSessao, limpaTokenDaUrl } from "./os-session";

// ANTES de qualquer componente montar: o interceptor precisa existir antes do PRIMEIRO
// fetch (o ProjectsModal ja chama /api/projects no mount). Instalar depois deixaria so a
// primeira chamada sair sem token -> 401 intermitente no load inicial, o pior tipo de bug.
instalaInterceptorDeSessao();
limpaTokenDaUrl();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
