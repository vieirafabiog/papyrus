import {
  CONTRACTS_API_PREFIX,
  type DocumentListResponse,
  type FolderRecord,
  type FolderStatus,
  documentListResponseSchema,
  folderListResponseSchema,
  folderResponseSchema,
  uuidSchema,
} from "@papyrus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import {
  type MessageKey,
  type UiLocale,
  getCurrentUiLocale,
  translate,
  useI18n,
} from "../../i18n/index.js";

const CSRF_HEADER_NAME = "x-csrf-token";
const MAX_BREADCRUMB_DEPTH = 20;

export type FolderNavigationErrorKind = "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "NETWORK";

export class FolderNavigationError extends Error {
  public readonly kind: FolderNavigationErrorKind;
  public readonly statusCode: number;

  public constructor(kind: FolderNavigationErrorKind, message: string, statusCode: number) {
    super(message);
    this.name = "FolderNavigationError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export interface FolderBreadcrumbItem {
  readonly id: string | null;
  readonly label: string;
  readonly status: FolderStatus | null;
  readonly accessible: boolean;
  readonly removed?: boolean | undefined;
}

export type FolderStatusFilter = "ACTIVE" | "ALL" | "ARCHIVED";

export interface FolderNavigationResult {
  readonly currentFolder: FolderRecord | null;
  readonly breadcrumbs: readonly FolderBreadcrumbItem[];
  readonly subfolders: readonly FolderRecord[];
  readonly documents: DocumentListResponse | null;
  readonly archivedNotice: string | null;
}

async function resolveCsrfToken(): Promise<string> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return "";
  }
  const raw: unknown = await response.json();
  if (raw && typeof raw === "object" && "data" in raw) {
    const data = (raw as { data?: unknown }).data;
    if (data && typeof data === "object" && "csrfToken" in data) {
      const token = (data as { csrfToken?: unknown }).csrfToken;
      if (typeof token === "string") {
        return token;
      }
    }
  }
  return "";
}

async function parseFolderApiError(
  response: Response,
  fallbackKey: MessageKey,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<FolderNavigationError> {
  const message = await extractUserErrorMessage(response, fallbackKey, locale);

  if (response.status === 403) {
    return new FolderNavigationError("FORBIDDEN", message, 403);
  }
  if (response.status === 404) {
    return new FolderNavigationError("NOT_FOUND", message, 404);
  }
  if (response.status === 400) {
    return new FolderNavigationError("VALIDATION", message, 400);
  }
  return new FolderNavigationError("NETWORK", message, response.status);
}

/**
 * Loads a single folder directly from the server so folder-level READ authorization
 * and removed/archived states are always verified by the server.
 */
export async function fetchAuthorizedFolderById(
  folderId: string,
  signal?: AbortSignal,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<FolderRecord> {
  if (!uuidSchema.safeParse(folderId).success) {
    throw new FolderNavigationError(
      "NOT_FOUND",
      translate("folders.errors.notFound", undefined, locale),
      404,
    );
  }

  const response = await fetch(`${CONTRACTS_API_PREFIX}/folders/${folderId}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const fallbackKey: MessageKey =
      response.status === 403
        ? "folders.errors.forbidden"
        : response.status === 404
          ? "folders.errors.notFound"
          : "folders.errors.loadFailed";
    throw await parseFolderApiError(response, fallbackKey, locale);
  }

  const rawJson: unknown = await response.json();
  const parsed = folderResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FolderNavigationError(
      "NETWORK",
      translate("common.errors.unexpectedResponse", undefined, locale),
      502,
    );
  }

  return parsed.data.data;
}

/**
 * Resolves the hierarchical breadcrumb path for `currentFolder`, authorizing every
 * ancestor step against the server and handling restricted or missing ancestors safely.
 */
export async function resolveAuthorizedBreadcrumbs(
  currentFolder: FolderRecord,
  signal?: AbortSignal,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<{
  readonly breadcrumbs: readonly FolderBreadcrumbItem[];
  readonly archivedNotice: string | null;
}> {
  const chain: FolderBreadcrumbItem[] = [
    {
      id: currentFolder.id,
      label: currentFolder.name,
      status: currentFolder.status,
      accessible: true,
    },
  ];

  const visited = new Set<string>([currentFolder.id]);
  let cursorParentId = currentFolder.parentId;
  let archivedNotice: string | null =
    currentFolder.status === "ARCHIVED"
      ? translate("folders.archived.currentNotice", undefined, locale)
      : null;

  let depth = 0;
  while (cursorParentId !== null && depth < MAX_BREADCRUMB_DEPTH) {
    if (visited.has(cursorParentId)) {
      break;
    }
    visited.add(cursorParentId);
    depth += 1;

    try {
      const ancestor = await fetchAuthorizedFolderById(cursorParentId, signal, locale);
      chain.unshift({
        id: ancestor.id,
        label: ancestor.name,
        status: ancestor.status,
        accessible: true,
      });
      if (ancestor.status === "ARCHIVED" && archivedNotice === null) {
        archivedNotice = translate(
          "folders.archived.ancestorNotice",
          { name: ancestor.name },
          locale,
        );
      }
      cursorParentId = ancestor.parentId;
    } catch (error) {
      if (error instanceof FolderNavigationError && error.kind === "FORBIDDEN") {
        chain.unshift({
          id: cursorParentId,
          label: translate("folders.breadcrumbs.restrictedParent", undefined, locale),
          status: null,
          accessible: false,
        });
        break;
      }
      if (error instanceof FolderNavigationError && error.kind === "NOT_FOUND") {
        chain.unshift({
          id: cursorParentId,
          label: translate("folders.breadcrumbs.removedParent", undefined, locale),
          status: null,
          accessible: false,
          removed: true,
        });
        break;
      }
      throw error;
    }
  }

  const breadcrumbs: FolderBreadcrumbItem[] = [
    {
      id: null,
      label: translate("folders.breadcrumbs.root", undefined, locale),
      status: "ACTIVE",
      accessible: true,
    },
    ...chain,
  ];

  return { breadcrumbs, archivedNotice };
}

export async function fetchAuthorizedSubfolders(
  parentId: string | null,
  statusFilter: FolderStatusFilter,
  search: string,
  signal?: AbortSignal,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<readonly FolderRecord[]> {
  const params = new URLSearchParams();
  params.set("page", "1");
  params.set("pageSize", "100");
  params.set("sortBy", "name");
  params.set("sortDirection", "asc");
  if (parentId === null) {
    params.set("rootOnly", "true");
  } else {
    params.set("parentId", parentId);
  }
  if (statusFilter !== "ALL") {
    params.set("status", statusFilter);
  }
  const trimmedSearch = search.trim();
  if (trimmedSearch.length > 0) {
    params.set("search", trimmedSearch);
  }

  const response = await fetch(`${CONTRACTS_API_PREFIX}/folders?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw await parseFolderApiError(response, "folders.errors.listFailed", locale);
  }

  const rawJson: unknown = await response.json();
  const parsed = folderListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FolderNavigationError(
      "NETWORK",
      translate("common.errors.unexpectedResponse", undefined, locale),
      502,
    );
  }

  return parsed.data.data.items;
}

export async function fetchAuthorizedFolderDocuments(
  folderId: string | null,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<DocumentListResponse> {
  const params = new URLSearchParams({
    ...(folderId === null ? { rootOnly: "true" } : { folderId }),
    page: String(page),
    pageSize: String(pageSize),
    sortBy: "updatedAt",
    sortDirection: "desc",
  });

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/search?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw await parseFolderApiError(response, "folders.errors.documentsLoadFailed", locale);
  }

  const rawJson: unknown = await response.json();
  const parsed = documentListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FolderNavigationError(
      "NETWORK",
      translate("common.errors.unexpectedResponse", undefined, locale),
      502,
    );
  }

  return parsed.data;
}

export async function loadFolderNavigationState(
  folderId: string | null,
  options: {
    readonly statusFilter: FolderStatusFilter;
    readonly search: string;
    readonly docPage: number;
    readonly docPageSize: number;
  },
  signal?: AbortSignal,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<FolderNavigationResult> {
  if (folderId === null) {
    const [subfolders, documents] = await Promise.all([
      fetchAuthorizedSubfolders(null, options.statusFilter, options.search, signal, locale),
      fetchAuthorizedFolderDocuments(null, options.docPage, options.docPageSize, signal, locale),
    ]);
    return {
      currentFolder: null,
      breadcrumbs: [
        {
          id: null,
          label: translate("folders.breadcrumbs.root", undefined, locale),
          status: "ACTIVE",
          accessible: true,
        },
      ],
      subfolders,
      documents,
      archivedNotice: null,
    };
  }

  const currentFolder = await fetchAuthorizedFolderById(folderId, signal, locale);
  const [trail, subfolders, documents] = await Promise.all([
    resolveAuthorizedBreadcrumbs(currentFolder, signal, locale),
    fetchAuthorizedSubfolders(
      currentFolder.id,
      options.statusFilter,
      options.search,
      signal,
      locale,
    ),
    fetchAuthorizedFolderDocuments(
      currentFolder.id,
      options.docPage,
      options.docPageSize,
      signal,
      locale,
    ),
  ]);

  return {
    currentFolder,
    breadcrumbs: trail.breadcrumbs,
    subfolders,
    documents,
    archivedNotice: trail.archivedNotice,
  };
}

export function folderNavigationQueryKey(
  folderId: string | null,
  statusFilter: FolderStatusFilter,
  search: string,
  docPage: number,
  docPageSize: number,
  locale: UiLocale = getCurrentUiLocale(),
) {
  return [
    "folders",
    "navigation",
    folderId ?? "root",
    statusFilter,
    search,
    docPage,
    docPageSize,
    locale,
  ] as const;
}

/**
 * Query hook enforcing fresh server authorization and state resolution on each
 * folder navigation step.
 */
export function useFolderNavigationQuery(
  folderId: string | null,
  options: {
    readonly statusFilter: FolderStatusFilter;
    readonly search: string;
    readonly docPage: number;
    readonly docPageSize: number;
  },
) {
  const { locale } = useI18n();
  return useQuery<FolderNavigationResult, Error>({
    queryKey: folderNavigationQueryKey(
      folderId,
      options.statusFilter,
      options.search,
      options.docPage,
      options.docPageSize,
      locale,
    ),
    queryFn: ({ signal }) => loadFolderNavigationState(folderId, options, signal, locale),
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

export function useCreateFolderMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    FolderRecord,
    Error,
    { readonly name: string; readonly parentId: string | null }
  >({
    mutationFn: async (input) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/folders`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        throw await parseFolderApiError(response, "folders.feedback.createError");
      }

      const rawJson: unknown = await response.json();
      const parsed = folderResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error(translate("common.errors.unexpectedResponse"));
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders", "navigation"] }),
        queryClient.invalidateQueries({ queryKey: ["folders", "filter-options"] }),
      ]);
    },
  });
}

export function useRenameFolderMutation() {
  const queryClient = useQueryClient();
  return useMutation<FolderRecord, Error, { readonly folderId: string; readonly name: string }>({
    mutationFn: async ({ folderId, name }) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/folders/${folderId}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        throw await parseFolderApiError(response, "folders.feedback.renameError");
      }

      const rawJson: unknown = await response.json();
      const parsed = folderResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error(translate("common.errors.unexpectedResponse"));
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders", "navigation"] }),
        queryClient.invalidateQueries({ queryKey: ["folders", "filter-options"] }),
      ]);
    },
  });
}

export function useArchiveFolderMutation() {
  const queryClient = useQueryClient();
  return useMutation<FolderRecord, Error, { readonly folderId: string }>({
    mutationFn: async ({ folderId }) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/folders/${folderId}/archive`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
      });

      if (!response.ok) {
        throw await parseFolderApiError(response, "folders.feedback.archiveError");
      }

      const rawJson: unknown = await response.json();
      const parsed = folderResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error(translate("common.errors.unexpectedResponse"));
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders", "navigation"] }),
        queryClient.invalidateQueries({ queryKey: ["folders", "filter-options"] }),
      ]);
    },
  });
}
