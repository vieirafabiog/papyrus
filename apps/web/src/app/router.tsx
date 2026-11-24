import { Box, Typography } from "@mui/material";
import { Navigate, Route, Routes } from "react-router-dom";
import { CategoriesPage } from "../features/admin/CategoriesPage.js";
import { GroupsPage } from "../features/admin/GroupsPage.js";
import { OrganizationSettingsPage } from "../features/admin/OrganizationSettingsPage.js";
import { PermissionsPage } from "../features/admin/PermissionsPage.js";
import { StorageSettingsPage } from "../features/admin/StorageSettingsPage.js";
import { SystemStatusPage } from "../features/admin/SystemStatusPage.js";
import { UsersPage } from "../features/admin/UsersPage.js";
import { AuditPage } from "../features/audit/AuditPage.js";
import { LoginPage } from "../features/auth/LoginPage.js";
import { DashboardPage } from "../features/dashboard/DashboardPage.js";
import { DocumentDetailsPage } from "../features/documents/DocumentDetailsPage.js";
import { DocumentListPage } from "../features/documents/DocumentListPage.js";
import { TrashDocumentsPage } from "../features/documents/TrashDocumentsPage.js";
import { ExpirationsPage } from "../features/expirations/ExpirationsPage.js";
import { FoldersPage } from "../features/folders/FoldersPage.js";
import { ReportsPage } from "../features/reports/ReportsPage.js";
import { TagsPage } from "../features/tags/TagsPage.js";
import { TaskInboxPage } from "../features/tasks/TaskInboxPage.js";
import { TaskReviewPage } from "../features/tasks/TaskReviewPage.js";
import { WorkflowsPage } from "../features/workflows/WorkflowsPage.js";
import { AppShell } from "../layout/AppShell.js";
import { RedirectIfAuthenticated, RequireAuth } from "./route-guards.js";

interface PublicRouteViewProps {
  readonly title: string;
  readonly description: string;
}

function PublicRouteView({ title, description }: PublicRouteViewProps) {
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
          <Route path="/categorias" element={<CategoriesPage />} />
          <Route path="/etiquetas" element={<TagsPage />} />
          <Route path="/fluxos" element={<WorkflowsPage />} />
          <Route path="/tarefas" element={<TaskInboxPage />} />
          <Route path="/tarefas/:id" element={<TaskReviewPage />} />
          <Route path="/vencimentos" element={<ExpirationsPage />} />
          <Route path="/relatorios" element={<ReportsPage />} />
          <Route path="/admin/usuarios" element={<UsersPage />} />
          <Route path="/admin/grupos" element={<GroupsPage />} />
          <Route path="/admin/permissoes" element={<PermissionsPage />} />
          <Route path="/admin/armazenamento" element={<StorageSettingsPage />} />
          <Route path="/admin/status" element={<SystemStatusPage />} />
          <Route path="/admin/auditoria" element={<AuditPage />} />
          <Route path="/admin/configuracoes" element={<OrganizationSettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
