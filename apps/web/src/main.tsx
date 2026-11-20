import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Elemento raiz #root não encontrado.");
}

createRoot(rootElement).render(
  <StrictMode>
    <main>
      <h1>DocuFlow</h1>
    </main>
  </StrictMode>,
);
