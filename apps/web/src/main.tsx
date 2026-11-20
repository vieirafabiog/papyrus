import { Box, Typography } from "@mui/material";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "./app/providers.js";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Elemento raiz #root não encontrado.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <Box component="main" sx={{ p: 3 }}>
        <Typography variant="h1">DocuFlow</Typography>
      </Box>
    </AppProviders>
  </StrictMode>,
);
