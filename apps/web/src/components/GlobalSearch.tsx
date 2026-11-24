import {
  CONTRACTS_API_PREFIX,
  type DocumentListItem,
  type DocumentStatus,
  documentListResponseSchema,
} from "@docuflow/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  ClickAwayListener,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Popper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { extractUserErrorMessage } from "../i18n/api-errors.js";
import { type MessageKey, translate, useI18n } from "../i18n/index.js";

const DEFAULT_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;

const STATUS_META: Readonly<
  Record<
    DocumentStatus,
    {
      readonly labelKey: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  DRAFT: { labelKey: "search.status.DRAFT", color: "default" },
  IN_REVIEW: { labelKey: "search.status.IN_REVIEW", color: "info" },
  APPROVED: { labelKey: "search.status.APPROVED", color: "success" },
  REJECTED: { labelKey: "search.status.REJECTED", color: "error" },
  ARCHIVED: { labelKey: "search.status.ARCHIVED", color: "default" },
  EXPIRED: { labelKey: "search.status.EXPIRED", color: "warning" },
  DELETED: { labelKey: "search.status.DELETED", color: "error" },
};

class LocalizedSearchError extends Error {}

export interface GlobalSearchProps {
  readonly debounceMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * Global authorized document search input with debounce, AbortController cancellation,
 * empty/error states, keyboard navigation, and direct navigation to document details.
 */
export function GlobalSearch({ debounceMs = DEFAULT_DEBOUNCE_MS, fetchFn }: GlobalSearchProps) {
  const { t, locale, formatDate, formatNumber } = useI18n();
  const navigate = useNavigate();
  const inputId = useId();
  const listboxId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const [queryText, setQueryText] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<readonly DocumentListItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [hasSearchedTerm, setHasSearchedTerm] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const trimmedQuery = queryText.trim();
  const fetchImpl = fetchFn ?? globalThis.fetch;

  useEffect(() => {
    if (trimmedQuery.length < MIN_SEARCH_LENGTH) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setLoading(false);
      setErrorMessage(null);
      setResults([]);
      setTotalItems(0);
      setHasSearchedTerm(null);
      setActiveIndex(-1);
      return;
    }

    const timerId = window.setTimeout(() => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setErrorMessage(null);
      setOpen(true);

      const url = `${CONTRACTS_API_PREFIX}/documents/search?search=${encodeURIComponent(
        trimmedQuery,
      )}&page=1&pageSize=8&sortBy=updatedAt&sortDirection=desc`;

      void fetchImpl(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          const activeLocale = localeRef.current;
          if (!response.ok) {
            throw new LocalizedSearchError(
              await extractUserErrorMessage(response, "search.errorGeneric", activeLocale),
            );
          }
          const rawJson: unknown = await response.json();
          const parsed = documentListResponseSchema.safeParse(rawJson);
          if (!parsed.success) {
            throw new LocalizedSearchError(
              translate("common.errors.unexpectedResponse", undefined, activeLocale),
            );
          }
          if (!controller.signal.aborted) {
            setResults(parsed.data.items);
            setTotalItems(parsed.data.pagination.totalItems);
            setHasSearchedTerm(trimmedQuery);
            setActiveIndex(parsed.data.items.length > 0 ? 0 : -1);
            setLoading(false);
          }
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          if (!controller.signal.aborted) {
            const activeLocale = localeRef.current;
            setResults([]);
            setTotalItems(0);
            setHasSearchedTerm(trimmedQuery);
            setErrorMessage(
              error instanceof LocalizedSearchError
                ? error.message
                : translate("search.errorGeneric", undefined, activeLocale),
            );
            setLoading(false);
          }
        });
    }, debounceMs);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [trimmedQuery, debounceMs, fetchImpl]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleSelectDocument = (documentId: string): void => {
    setOpen(false);
    setActiveIndex(-1);
    void navigate(`/documents/${documentId}`);
  };

  const handleClear = (): void => {
    abortControllerRef.current?.abort();
    setQueryText("");
    setResults([]);
    setTotalItems(0);
    setHasSearchedTerm(null);
    setErrorMessage(null);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (!open || results.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      const selected = results[activeIndex];
      if (selected) {
        event.preventDefault();
        handleSelectDocument(selected.id);
      }
    }
  };

  const showPopover =
    open && (trimmedQuery.length >= MIN_SEARCH_LENGTH || trimmedQuery.length === 1);

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box
        ref={anchorRef}
        onKeyDown={handleKeyDown}
        sx={{
          position: "relative",
          width: "100%",
          maxWidth: 420,
        }}
      >
        <TextField
          id={inputId}
          size="small"
          fullWidth
          value={queryText}
          onFocus={() => {
            if (trimmedQuery.length > 0) {
              setOpen(true);
            }
          }}
          onChange={(event) => {
            setQueryText(event.target.value);
            if (event.target.value.trim().length > 0) {
              setOpen(true);
            } else {
              setOpen(false);
            }
          }}
          placeholder={t("search.placeholder")}
          slotProps={{
            htmlInput: {
              "aria-label": t("search.ariaLabel"),
              "aria-controls": showPopover ? listboxId : undefined,
              "aria-expanded": showPopover,
            },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
              endAdornment:
                queryText.length > 0 ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label={t("search.clearAriaLabel")}
                      onClick={handleClear}
                      edge="end"
                    >
                      <ClearOutlinedIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
            },
          }}
        />

        <Popper
          open={showPopover}
          anchorEl={anchorRef.current}
          placement="bottom-start"
          style={{
            zIndex: 1300,
            width: anchorRef.current ? anchorRef.current.clientWidth : 360,
          }}
        >
          <Paper
            elevation={3}
            sx={{
              mt: 0.75,
              border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
              maxHeight: 360,
              overflowY: "auto",
            }}
          >
            {trimmedQuery.length < MIN_SEARCH_LENGTH ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("search.minChars", { count: MIN_SEARCH_LENGTH })}
                </Typography>
              </Box>
            ) : loading ? (
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ p: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {t("search.loading")}
                </Typography>
              </Stack>
            ) : errorMessage ? (
              <Box sx={{ p: 1.5 }}>
                <Alert severity="error" role="alert">
                  {errorMessage}
                </Alert>
              </Box>
            ) : results.length === 0 && hasSearchedTerm !== null ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" fontWeight={500}>
                  {t("search.emptyTitle")}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t("search.emptyDescription", { query: hasSearchedTerm })}
                </Typography>
              </Box>
            ) : (
              <List id={listboxId} aria-label={t("search.resultsAriaLabel")} dense disablePadding>
                {results.map((doc, index) => {
                  const statusMeta = STATUS_META[doc.status];
                  return (
                    <ListItemButton
                      key={doc.id}
                      aria-current={index === activeIndex ? "true" : undefined}
                      selected={index === activeIndex}
                      onClick={() => handleSelectDocument(doc.id)}
                      sx={{ alignItems: "flex-start", py: 1 }}
                    >
                      <ListItemIcon sx={{ minWidth: 32, mt: 0.25 }}>
                        <DescriptionOutlinedIcon fontSize="small" color="primary" />
                      </ListItemIcon>
                      <ListItemText
                        slotProps={{ secondary: { component: "div" } }}
                        primary={
                          <Typography variant="body2" fontWeight={500} noWrap>
                            {doc.title}
                          </Typography>
                        }
                        secondary={
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
                            <Chip
                              label={t(statusMeta.labelKey)}
                              color={statusMeta.color}
                              size="small"
                            />
                            <Typography variant="caption" color="text.secondary">
                              {t("search.updatedAt", { date: formatDate(doc.updatedAt) })}
                            </Typography>
                          </Stack>
                        }
                      />
                    </ListItemButton>
                  );
                })}
                {totalItems > results.length ? (
                  <Box
                    sx={{
                      px: 2,
                      py: 1,
                      borderTop: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      {t("search.showingCount", {
                        shown: formatNumber(results.length),
                        total: formatNumber(totalItems),
                      })}
                    </Typography>
                  </Box>
                ) : null}
              </List>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
