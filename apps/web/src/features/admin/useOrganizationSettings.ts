import {
  CONTRACTS_API_PREFIX,
  type OrganizationSettingsViewContract,
  type UpdateOrganizationSettingsRequest,
  organizationSettingsResponseSchema,
  updateOrganizationSettingsRequestSchema,
} from "@papyrus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "papyrus_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export class OrganizationSettingsFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "OrganizationSettingsFetchError";
    this.statusCode = statusCode;
  }
}

export function organizationSettingsQueryKey() {
  return ["organization", "settings"] as const;
}

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

async function parseErrorResponse(
  response: Response,
  fallbackKey: MessageKey,
): Promise<OrganizationSettingsFetchError> {
  const message = await extractUserErrorMessage(response, fallbackKey);
  return new OrganizationSettingsFetchError(response.status, message);
}

export async function fetchOrganizationSettings(): Promise<OrganizationSettingsViewContract> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/organization`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.organization.errors.loadFailed");
  }

  const rawJson: unknown = await response.json();
  const parsed = organizationSettingsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new OrganizationSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function updateOrganizationSettings(
  payload: UpdateOrganizationSettingsRequest,
): Promise<OrganizationSettingsViewContract> {
  const validated = updateOrganizationSettingsRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/organization`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.organization.errors.saveFailed");
  }

  const rawJson: unknown = await response.json();
  const parsed = organizationSettingsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new OrganizationSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export function useOrganizationSettingsQuery() {
  return useQuery<OrganizationSettingsViewContract, OrganizationSettingsFetchError>({
    queryKey: organizationSettingsQueryKey(),
    queryFn: fetchOrganizationSettings,
  });
}

export function useUpdateOrganizationSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateOrganizationSettings,
    onSuccess: (updated) => {
      queryClient.setQueryData(organizationSettingsQueryKey(), updated);
    },
  });
}
