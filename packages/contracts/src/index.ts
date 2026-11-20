export const CONTRACTS_API_PREFIX = "/api/v1" as const;

export {
  type ApiErrorResponse,
  apiErrorResponseSchema,
  createApiResponseSchema,
  createPaginatedResponseSchema,
  createSortSchema,
  type ErrorCode,
  errorCodeSchema,
  type IsoDate,
  type IsoDateTime,
  isoDateSchema,
  isoDateTimeSchema,
  type PaginationMeta,
  type PaginationQuery,
  paginationMetaSchema,
  paginationQuerySchema,
  type SortDirection,
  sortDirectionSchema,
  type Uuid,
  uuidSchema,
} from "./common.schema.js";
