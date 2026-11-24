import { Box, Typography } from "@mui/material";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
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
import { useI18n } from "../i18n/index.js";
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

function ForgotPasswordRouteView() {
  const { t } = useI18n();
  return (
    <PublicRouteView
      title={t("auth.forgotPassword.title")}
      description={t("auth.forgotPassword.description")}
    />
  );
}

interface LegacyRouteRedirectProps {
  readonly targetPrefix: string;
  readonly paramKey?: "id" | "folderId" | undefined;
}

/**
 * Preserves backward compatibility for legacy Portuguese URLs by redirecting
 * to their canonical English paths while retaining dynamic params and query strings.
 */
function LegacyRouteRedirect({ targetPrefix, paramKey }: LegacyRouteRedirectProps) {
  const params = useParams();
  const location = useLocation();
  const dynamicSegment = paramKey ? params[paramKey] : undefined;
  const targetPath = dynamicSegment
    ? `${targetPrefix}/${encodeURIComponent(dynamicSegment)}`
    : targetPrefix;
  return <Navigate to={`${targetPath}${location.search}`} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RedirectIfAuthenticated />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordRouteView />} />
        <Route
          path="/recuperar-senha"
          element={<LegacyRouteRedirect targetPrefix="/forgot-password" />}
        />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />

          {/* Canonical English routes */}
          <Route path="/documents" element={<DocumentListPage />} />
          <Route path="/documents/:id" element={<DocumentDetailsPage />} />
          <Route path="/trash" element={<TrashDocumentsPage />} />
          <Route path="/folders" element={<FoldersPage />} />
          <Route path="/folders/:folderId" element={<FoldersPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/tasks" element={<TaskInboxPage />} />
          <Route path="/tasks/:id" element={<TaskReviewPage />} />
          <Route path="/expirations" element={<ExpirationsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/admin/groups" element={<GroupsPage />} />
          <Route path="/admin/permissions" element={<PermissionsPage />} />
          <Route path="/admin/storage" element={<StorageSettingsPage />} />
          <Route path="/admin/status" element={<SystemStatusPage />} />
          <Route path="/admin/audit" element={<AuditPage />} />
          <Route path="/admin/settings" element={<OrganizationSettingsPage />} />

          {/* Legacy Portuguese route compatibility redirects */}
          <Route path="/documentos" element={<LegacyRouteRedirect targetPrefix="/documents" />} />
          <Route
            path="/documentos/:id"
            element={<LegacyRouteRedirect targetPrefix="/documents" paramKey="id" />}
          />
          <Route path="/lixeira" element={<LegacyRouteRedirect targetPrefix="/trash" />} />
          <Route path="/pastas" element={<LegacyRouteRedirect targetPrefix="/folders" />} />
          <Route
            path="/pastas/:folderId"
            element={<LegacyRouteRedirect targetPrefix="/folders" paramKey="folderId" />}
          />
          <Route path="/categorias" element={<LegacyRouteRedirect targetPrefix="/categories" />} />
          <Route path="/etiquetas" element={<LegacyRouteRedirect targetPrefix="/tags" />} />
          <Route path="/fluxos" element={<LegacyRouteRedirect targetPrefix="/workflows" />} />
          <Route path="/tarefas" element={<LegacyRouteRedirect targetPrefix="/tasks" />} />
          <Route
            path="/tarefas/:id"
            element={<LegacyRouteRedirect targetPrefix="/tasks" paramKey="id" />}
          />
          <Route
            path="/vencimentos"
            element={<LegacyRouteRedirect targetPrefix="/expirations" />}
          />
          <Route path="/relatorios" element={<LegacyRouteRedirect targetPrefix="/reports" />} />
          <Route
            path="/admin/usuarios"
            element={<LegacyRouteRedirect targetPrefix="/admin/users" />}
          />
          <Route
            path="/admin/grupos"
            element={<LegacyRouteRedirect targetPrefix="/admin/groups" />}
          />
          <Route
            path="/admin/permissoes"
            element={<LegacyRouteRedirect targetPrefix="/admin/permissions" />}
          />
          <Route
            path="/admin/armazenamento"
            element={<LegacyRouteRedirect targetPrefix="/admin/storage" />}
          />
          <Route
            path="/admin/auditoria"
            element={<LegacyRouteRedirect targetPrefix="/admin/audit" />}
          />
          <Route
            path="/admin/configuracoes"
            element={<LegacyRouteRedirect targetPrefix="/admin/settings" />}
          />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
