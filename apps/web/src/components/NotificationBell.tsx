import DoneOutlinedIcon from "@mui/icons-material/DoneOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import RuleOutlinedIcon from "@mui/icons-material/RuleOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  ListItem,
  Popover,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import {
  CONTRACTS_API_PREFIX,
  type NotificationItem,
  type NotificationKindContract,
  type NotificationListResponse,
  notificationDetailResponseSchema,
  notificationListResponseSchema,
} from "@papyrus/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { extractUserErrorMessage } from "../i18n/api-errors.js";
import { type MessageKey, translate, useI18n } from "../i18n/index.js";

const CSRF_COOKIE_NAME = "papyrus_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

const NOTIFICATION_KIND_META: Readonly<
  Record<
    NotificationKindContract,
    {
      readonly labelKey: MessageKey;
      readonly color: "info" | "success" | "warning";
    }
  >
> = {
  TASK_ASSIGNED: { labelKey: "notifications.kind.TASK_ASSIGNED", color: "info" },
  WORKFLOW_DECISION: { labelKey: "notifications.kind.WORKFLOW_DECISION", color: "success" },
  DOCUMENT_EXPIRATION: { labelKey: "notifications.kind.DOCUMENT_EXPIRATION", color: "warning" },
};

class LocalizedNotificationError extends Error {}

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

async function resolveCsrfToken(): Promise<string> {
  const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }
  const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return "";
  }
  const json = (await response.json()) as { data?: { csrfToken?: string } };
  return json.data?.csrfToken ?? "";
}

export const NOTIFICATIONS_QUERY_KEY = ["notifications", "internal"] as const;

export async function fetchInternalNotifications(
  unreadOnly: boolean,
  signal?: AbortSignal,
): Promise<NotificationListResponse["data"] | null> {
  const params = new URLSearchParams({
    page: "1",
    pageSize: "20",
  });
  if (unreadOnly) {
    params.set("unreadOnly", "true");
  }

  const response = await fetch(`${CONTRACTS_API_PREFIX}/notifications?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 || response.status === 404 || response.status === 501) {
    return null;
  }

  if (!response.ok) {
    throw new LocalizedNotificationError(
      await extractUserErrorMessage(response, "notifications.loadError"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = notificationListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new LocalizedNotificationError(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function markNotificationRead(notificationId: string): Promise<NotificationItem> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/notifications/${encodeURIComponent(notificationId)}/read`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );

  if (!response.ok) {
    throw new LocalizedNotificationError(
      await extractUserErrorMessage(response, "notifications.markReadError"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = notificationDetailResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new LocalizedNotificationError(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

function resolveNotificationTarget(item: NotificationItem): string | null {
  if (!item.resourceId || !item.resourceType) {
    return null;
  }
  if (item.resourceType === "WORKFLOW_TASK") {
    return `/tasks/${encodeURIComponent(item.resourceId)}`;
  }
  if (item.resourceType === "DOCUMENT") {
    return `/documents/${encodeURIComponent(item.resourceId)}`;
  }
  return null;
}

function renderKindIcon(kind: NotificationKindContract) {
  switch (kind) {
    case "TASK_ASSIGNED":
      return <TaskAltOutlinedIcon fontSize="small" color="info" />;
    case "WORKFLOW_DECISION":
      return <RuleOutlinedIcon fontSize="small" color="success" />;
    case "DOCUMENT_EXPIRATION":
      return <EventBusyOutlinedIcon fontSize="small" color="warning" />;
  }
}

/**
 * Header bell trigger and popover displaying the authenticated user's internal notifications
 * with unread badge count, unread/all toggle, individual mark-as-read action, and scoped navigation.
 */
export function NotificationBell() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [pendingReadId, setPendingReadId] = useState<string | null>(null);

  const notificationsQuery = useQuery({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, unreadOnly],
    queryFn: ({ signal }) => fetchInternalNotifications(unreadOnly, signal),
    retry: false,
  });

  const markReadMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      setReadError(null);
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
    onError: (error) => {
      setReadError(
        error instanceof LocalizedNotificationError
          ? error.message
          : t("notifications.markReadError"),
      );
    },
    onSettled: () => {
      setPendingReadId(null);
    },
  });

  const open = Boolean(anchorEl);
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;
  const items = notificationsQuery.data?.items ?? [];

  const handleOpen = (event: MouseEvent<HTMLButtonElement>): void => {
    setReadError(null);
    setAnchorEl(event.currentTarget);
  };

  const handleClose = (): void => {
    setAnchorEl(null);
  };

  const handleMarkAsRead = (notificationId: string): void => {
    if (pendingReadId !== null) {
      return;
    }
    setReadError(null);
    setPendingReadId(notificationId);
    markReadMutation.mutate(notificationId);
  };

  const handleNavigateTarget = (item: NotificationItem): void => {
    const target = resolveNotificationTarget(item);
    if (!target) {
      return;
    }
    handleClose();
    void navigate(target);
  };

  return (
    <>
      <IconButton
        color="inherit"
        onClick={handleOpen}
        aria-label={
          unreadCount > 0
            ? t("notifications.ariaLabelUnread", { count: formatNumber(unreadCount) })
            : t("notifications.ariaLabel")
        }
        aria-controls={open ? "notifications-popover" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
      >
        <Badge badgeContent={unreadCount} color="error" max={99}>
          <NotificationsNoneOutlinedIcon />
        </Badge>
      </IconButton>

      <Popover
        id="notifications-popover"
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: "calc(100vw - 32px)", sm: 420 },
              maxHeight: 520,
              display: "flex",
              flexDirection: "column",
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
            <Typography variant="subtitle1" component="h2">
              {t("notifications.title")}
            </Typography>
            <IconButton
              size="small"
              aria-label={t("notifications.refreshAriaLabel")}
              disabled={notificationsQuery.isFetching}
              onClick={() => void notificationsQuery.refetch()}
            >
              <RefreshOutlinedIcon fontSize="small" />
            </IconButton>
          </Stack>

          <ToggleButtonGroup
            size="small"
            exclusive
            value={unreadOnly ? "unread" : "all"}
            onChange={(_event, nextValue: "all" | "unread" | null) => {
              if (nextValue !== null) {
                setUnreadOnly(nextValue === "unread");
              }
            }}
            aria-label={t("notifications.filterAriaLabel")}
            fullWidth
          >
            <ToggleButton value="all">{t("notifications.filterAll")}</ToggleButton>
            <ToggleButton value="unread">
              {t("notifications.filterUnread", { count: formatNumber(unreadCount) })}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Divider />

        {readError ? (
          <Alert severity="error" role="alert" sx={{ m: 1.5 }}>
            {readError}
          </Alert>
        ) : null}

        <Box sx={{ flex: 1, overflowY: "auto" }}>
          {notificationsQuery.isLoading ? (
            <Box sx={{ p: 2.5 }}>
              <Typography variant="body2" color="text.secondary">
                {t("notifications.loading")}
              </Typography>
            </Box>
          ) : notificationsQuery.isError ? (
            <Box sx={{ p: 2 }}>
              <Alert
                severity="error"
                action={
                  <Button size="small" onClick={() => void notificationsQuery.refetch()}>
                    {t("notifications.retry")}
                  </Button>
                }
              >
                {notificationsQuery.error instanceof LocalizedNotificationError
                  ? notificationsQuery.error.message
                  : t("notifications.loadError")}
              </Alert>
            </Box>
          ) : items.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">
                {unreadOnly ? t("notifications.emptyUnread") : t("notifications.emptyAll")}
              </Typography>
            </Box>
          ) : (
            <List disablePadding>
              {items.map((item) => {
                const isUnread = item.readAt === null;
                const kindMeta = NOTIFICATION_KIND_META[item.kind];
                const target = resolveNotificationTarget(item);
                const isMarkingThis = pendingReadId === item.id;

                return (
                  <ListItem
                    key={item.id}
                    divider
                    sx={{
                      alignItems: "flex-start",
                      flexDirection: "column",
                      gap: 1,
                      px: 2,
                      py: 1.5,
                      bgcolor: isUnread ? PAPYRUS_COLOR_TOKENS.surface.containerLow : "transparent",
                    }}
                  >
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      justifyContent="space-between"
                      sx={{ width: "100%" }}
                    >
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        {renderKindIcon(item.kind)}
                        <Chip label={t(kindMeta.labelKey)} color={kindMeta.color} size="small" />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {formatDateTime(item.createdAt)}
                      </Typography>
                    </Stack>

                    <Box sx={{ width: "100%" }}>
                      <Typography variant="body2" fontWeight={isUnread ? 600 : 500}>
                        {item.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                        {item.body}
                      </Typography>
                    </Box>

                    <Stack direction="row" spacing={1} alignItems="center">
                      {isUnread ? (
                        <Button
                          size="small"
                          variant="text"
                          startIcon={<DoneOutlinedIcon fontSize="small" />}
                          disabled={isMarkingThis || pendingReadId !== null}
                          onClick={() => handleMarkAsRead(item.id)}
                          aria-label={t("notifications.markAsReadAriaLabel", {
                            title: item.title,
                          })}
                        >
                          {isMarkingThis
                            ? t("notifications.markingAsRead")
                            : t("notifications.markAsRead")}
                        </Button>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {t("notifications.readStatus")}
                        </Typography>
                      )}

                      {target ? (
                        <Button
                          size="small"
                          variant="text"
                          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
                          onClick={() => handleNavigateTarget(item)}
                        >
                          {t("notifications.open")}
                        </Button>
                      ) : null}
                    </Stack>
                  </ListItem>
                );
              })}
            </List>
          )}
        </Box>
      </Popover>
    </>
  );
}
