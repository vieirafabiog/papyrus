import { Box, Typography } from "@mui/material";
import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.js";
import { AppShell } from "../layout/AppShell.js";
import { RouteLoadingFallback } from "./RouteLoadingFallback.js";
import { RedirectIfAuthenticated, RequireAuth } from "./route-guards.js";

const LoginPage = lazy(() =>
  import("../features/auth/LoginPage.js").then((m) => ({ default: m.LoginPage })),
);
const DashboardPage = lazy(() =>
  import("../features/dashboard/DashboardPage.js").then((m) => ({ default: m.DashboardPage })),
);
const DocumentListPage = lazy(() =>
  import("../features/documents/DocumentListPage.js").then((m) => ({
    default: m.DocumentListPage,
  })),
);
const DocumentDetailsPage = lazy(() =>
  import("../features/documents/DocumentDetailsPage.js").then((m) => ({
    default: m.DocumentDetailsPage,
  })),
);
const TrashDocumentsPage = lazy(() =>
  import("../features/documents/TrashDocumentsPage.js").then((m) => ({
    default: m.TrashDocumentsPage,
  })),
);
const FoldersPage = lazy(() =>
  import("../features/folders/FoldersPage.js").then((m) => ({ default: m.FoldersPage })),
);
const CategoriesPage = lazy(() =>
  import("../features/admin/CategoriesPage.js").then((m) => ({ default: m.CategoriesPage })),
);
const TagsPage = lazy(() =>
  import("../features/tags/TagsPage.js").then((m) => ({ default: m.TagsPage })),
);
const WorkflowsPage = lazy(() =>
  import("../features/workflows/WorkflowsPage.js").then((m) => ({ default: m.WorkflowsPage })),
);
const TaskInboxPage = lazy(() =>
  import("../features/tasks/TaskInboxPage.js").then((m) => ({ default: m.TaskInboxPage })),
);
const TaskReviewPage = lazy(() =>
  import("../features/tasks/TaskReviewPage.js").then((m) => ({ default: m.TaskReviewPage })),
);
const ExpirationsPage = lazy(() =>
  import("../features/expirations/ExpirationsPage.js").then((m) => ({
    default: m.ExpirationsPage,
  })),
);
const ReportsPage = lazy(() =>
  import("../features/reports/ReportsPage.js").then((m) => ({ default: m.ReportsPage })),
);
const UsersPage = lazy(() =>
  import("../features/admin/UsersPage.js").then((m) => ({ default: m.UsersPage })),
);
const GroupsPage = lazy(() =>
  import("../features/admin/GroupsPage.js").then((m) => ({ default: m.GroupsPage })),
);
const PermissionsPage = lazy(() =>
  import("../features/admin/PermissionsPage.js").then((m) => ({ default: m.PermissionsPage })),
);
const StorageSettingsPage = lazy(() =>
  import("../features/admin/StorageSettingsPage.js").then((m) => ({
    default: m.StorageSettingsPage,
  })),
);
const SystemStatusPage = lazy(() =>
  import("../features/admin/SystemStatusPage.js").then((m) => ({
    default: m.SystemStatusPage,
  })),
);
const AuditPage = lazy(() =>
  import("../features/audit/AuditPage.js").then((m) => ({ default: m.AuditPage })),
);
const OrganizationSettingsPage = lazy(() =>
  import("../features/admin/OrganizationSettingsPage.js").then((m) => ({
    default: m.OrganizationSettingsPage,
  })),
);
const PublicSharePage = lazy(() =>
  import("../features/documents/PublicSharePage.js").then((m) => ({
    default: m.PublicSharePage,
  })),
);

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
      <Route
        path="/share/:token"
        element={
          <Suspense fallback={<RouteLoadingFallback fullPage />}>
            <PublicSharePage />
          </Suspense>
        }
      />

      <Route element={<RedirectIfAuthenticated />}>
        <Route
          path="/login"
          element={
            <Suspense fallback={<RouteLoadingFallback fullPage />}>
              <LoginPage />
            </Suspense>
          }
        />
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
