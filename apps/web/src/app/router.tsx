import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "../features/auth/LoginPage.js";
import { DashboardPage } from "../features/dashboard/DashboardPage.js";
import { DocumentDetailsPage } from "../features/documents/DocumentDetailsPage.js";
import { UploadDialog } from "../features/documents/UploadDialog.js";
import { TagsPage } from "../features/tags/TagsPage.js";
import { AppShell } from "../layout/AppShell.js";
import { RedirectIfAuthenticated, RequireAuth } from "./route-guards.js";

interface RouteSectionProps {
  readonly title: string;
  readonly description: string;
}

function RouteSectionView({ title, description }: RouteSectionProps) {
  return (
    <Box>
      <Typography variant="h1" gutterBottom>
        {title}
      </Typography>
      <Typography variant="body1" color="text.secondary">
        {description}
      </Typography>
    </Box>
  );
}

function PublicRouteView({ title, description }: RouteSectionProps) {
  return (
    <Box component="main" sx={{ p: 3 }}>
      <Typography variant="h1" gutterBottom>
        {title}
      </Typography>
      <Typography variant="body1" color="text.secondary">
        {description}
      </Typography>
    </Box>
  );
}

function DocumentsEntryView() {
  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <Stack spacing={2.5}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            Documentos
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Pesquisa, filtros e gestão de versões documentais.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<CloudUploadOutlinedIcon />}
          onClick={() => setUploadOpen(true)}
        >
          Enviar documentos
        </Button>
      </Box>

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </Stack>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RedirectIfAuthenticated />}>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/recuperar-senha"
          element={
            <PublicRouteView
              title="Recuperação de senha"
              description="Solicite um link seguro de redefinição ao administrador ou via e-mail configurado."
            />
          }
        />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/documentos" element={<DocumentsEntryView />} />
          <Route path="/documentos/:id" element={<DocumentDetailsPage />} />
          <Route
            path="/pastas"
            element={
              <RouteSectionView
                title="Pastas"
                description="Estrutura hierárquica e permissões herdadas."
              />
            }
          />
          <Route
            path="/categorias"
            element={
              <RouteSectionView
                title="Categorias e campos"
                description="Configuração de tipos documentais e metadados."
              />
            }
          />
          <Route path="/etiquetas" element={<TagsPage />} />
          <Route
            path="/fluxos"
            element={
              <RouteSectionView
                title="Fluxos de aprovação"
                description="Definições sequenciais de revisão e aprovação."
              />
            }
          />
          <Route
            path="/tarefas"
            element={
              <RouteSectionView
                title="Minhas tarefas"
                description="Fila de revisões e aprovações atribuídas."
              />
            }
          />
          <Route
            path="/vencimentos"
            element={
              <RouteSectionView
                title="Vencimentos"
                description="Acompanhamento de documentos próximos do vencimento."
              />
            }
          />
          <Route
            path="/relatorios"
            element={
              <RouteSectionView
                title="Relatórios"
                description="Visão consolidada do acervo documental."
              />
            }
          />
          <Route
            path="/admin/usuarios"
            element={
              <RouteSectionView
                title="Usuários e grupos"
                description="Administração de contas e grupos de acesso."
              />
            }
          />
          <Route
            path="/admin/permissoes"
            element={
              <RouteSectionView
                title="Papéis e permissões"
                description="Matriz de ações e escopos de autorização."
              />
            }
          />
          <Route
            path="/admin/armazenamento"
            element={
              <RouteSectionView
                title="Armazenamento"
                description="Conexões de storage local e S3 compatível."
              />
            }
          />
          <Route
            path="/admin/auditoria"
            element={
              <RouteSectionView
                title="Auditoria"
                description="Registro de eventos de acesso e operações."
              />
            }
          />
          <Route
            path="/admin/configuracoes"
            element={
              <RouteSectionView
                title="Configurações"
                description="Preferências da organização e políticas de retenção."
              />
            }
          />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
