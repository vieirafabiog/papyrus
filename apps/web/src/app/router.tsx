import { Box, Typography } from "@mui/material";
import { Navigate, Route, Routes } from "react-router-dom";
import { OrganizationSettingsPage } from "../features/admin/OrganizationSettingsPage.js";
import { AuditPage } from "../features/audit/AuditPage.js";
import { LoginPage } from "../features/auth/LoginPage.js";
import { DashboardPage } from "../features/dashboard/DashboardPage.js";
import { DocumentDetailsPage } from "../features/documents/DocumentDetailsPage.js";
import { DocumentListPage } from "../features/documents/DocumentListPage.js";
import { TrashDocumentsPage } from "../features/documents/TrashDocumentsPage.js";
import { ExpirationsPage } from "../features/expirations/ExpirationsPage.js";
import { FoldersPage } from "../features/folders/FoldersPage.js";
import { TagsPage } from "../features/tags/TagsPage.js";
import { TaskInboxPage } from "../features/tasks/TaskInboxPage.js";
import { TaskReviewPage } from "../features/tasks/TaskReviewPage.js";
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
          <Route path="/documentos" element={<DocumentListPage />} />
          <Route path="/documentos/:id" element={<DocumentDetailsPage />} />
          <Route path="/lixeira" element={<TrashDocumentsPage />} />
          <Route path="/pastas" element={<FoldersPage />} />
          <Route path="/pastas/:folderId" element={<FoldersPage />} />
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
          <Route path="/tarefas" element={<TaskInboxPage />} />
          <Route path="/tarefas/:id" element={<TaskReviewPage />} />
          <Route path="/vencimentos" element={<ExpirationsPage />} />
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
          <Route path="/admin/auditoria" element={<AuditPage />} />
          <Route path="/admin/configuracoes" element={<OrganizationSettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
