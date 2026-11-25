import AlternateEmailOutlinedIcon from "@mui/icons-material/AlternateEmailOutlined";
import CommentOutlinedIcon from "@mui/icons-material/CommentOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  type DocumentCommentMention,
  type DocumentCommentRecord,
  type DocumentStatus,
  MAX_DOCUMENT_COMMENT_LENGTH,
  MAX_DOCUMENT_COMMENT_MENTIONS,
  type MentionCandidate,
} from "@papyrus/contracts";
import { ConfirmDialog, ErrorState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n/index.js";
import {
  useCreateDocumentCommentMutation,
  useDeleteDocumentCommentMutation,
  useDocumentCommentsQuery,
  useMentionCandidatesQuery,
} from "./useDocumentComments.js";

export interface DocumentCommentsPanelProps {
  readonly documentId: string;
  readonly documentStatus: DocumentStatus;
}

interface ActiveMentionToken {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly query: string;
}

function detectActiveMentionToken(text: string, caretPosition: number): ActiveMentionToken | null {
  const safeCaret = Math.max(0, Math.min(caretPosition, text.length));
  const textBeforeCaret = text.slice(0, safeCaret);
  const match = /(?:^|\s)(@([^\s@]{0,50}))$/.exec(textBeforeCaret);
  if (!match || !match[1]) {
    return null;
  }
  const atToken = match[1];
  const query = match[2] ?? "";
  const startIndex = safeCaret - atToken.length;
  return {
    startIndex,
    endIndex: safeCaret,
    query,
  };
}

function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderCommentBodyWithMentions(
  body: string,
  mentions: readonly DocumentCommentMention[],
): ReactNode {
  if (mentions.length === 0) {
    return body;
  }

  const sortedMentions = [...mentions].sort((a, b) => b.fullName.length - a.fullName.length);
  const pattern = sortedMentions.map((mention) => `@${escapeRegExp(mention.fullName)}`).join("|");
  if (!pattern) {
    return body;
  }

  const regex = new RegExp(`(${pattern})`, "gi");
  const mentionNamesLower = new Set(mentions.map((m) => `@${m.fullName.toLowerCase()}`));
  const segments = body.split(regex);

  return segments.map((segment, index) => {
    if (mentionNamesLower.has(segment.toLowerCase())) {
      return (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: static text segments from deterministic split
          key={`mention-seg-${index}`}
          component="span"
          sx={{
            fontWeight: 600,
            color: PAPYRUS_COLOR_TOKENS.primary.onContainer,
            bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
            px: 0.6,
            py: 0.1,
            borderRadius: 1,
          }}
        >
          {segment}
        </Box>
      );
    }
    return segment;
  });
}

/**
 * Displays collaborative document comments with `@mention` autocomplete,
 * server-backed candidate lookup, highlight rendering, and safe deletion controls.
 */
export function DocumentCommentsPanel({ documentId, documentStatus }: DocumentCommentsPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const [page, setPage] = useState(1);
  const [body, setBody] = useState("");
  const [activeToken, setActiveToken] = useState<ActiveMentionToken | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<readonly MentionCandidate[]>([]);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);
  const [commentToDelete, setCommentToDelete] = useState<DocumentCommentRecord | null>(null);

  const isDeletedDocument = documentStatus === "DELETED";

  const commentsQuery = useDocumentCommentsQuery(documentId, page, 20);
  const mentionQuery = useMentionCandidatesQuery(
    documentId,
    activeToken?.query ?? "",
    activeToken !== null && !isDeletedDocument,
  );
  const createMutation = useCreateDocumentCommentMutation(documentId);
  const deleteMutation = useDeleteDocumentCommentMutation(documentId);

  const candidates = mentionQuery.data ?? [];
  const activeCandidateIndex =
    candidates.length === 0 ? 0 : Math.min(highlightedIndex, candidates.length - 1);

  const activeSelectedMentions = selectedMentions.filter((mention) =>
    body.toLowerCase().includes(`@${mention.fullName.toLowerCase()}`),
  );

  const handleBodyChange = (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    const nextValue = event.target.value;
    const caret = event.target.selectionStart ?? nextValue.length;
    setBody(nextValue);
    setFeedback(null);
    const token = detectActiveMentionToken(nextValue, caret);
    setActiveToken(token);
    setHighlightedIndex(0);
  };

  const applyMentionCandidate = (candidate: MentionCandidate): void => {
    const currentCaret = inputRef.current?.selectionStart ?? body.length;
    const token = activeToken ?? detectActiveMentionToken(body, currentCaret);
    const replacement = `@${candidate.fullName} `;

    let nextText: string;
    let nextCaretPosition: number;

    if (token) {
      nextText = `${body.slice(0, token.startIndex)}${replacement}${body.slice(token.endIndex)}`;
      nextCaretPosition = token.startIndex + replacement.length;
    } else {
      const prefixSpace = body.length > 0 && !body.endsWith(" ") ? " " : "";
      nextText = `${body}${prefixSpace}${replacement}`;
      nextCaretPosition = nextText.length;
    }

    setBody(nextText.slice(0, MAX_DOCUMENT_COMMENT_LENGTH));
    setActiveToken(null);
    setHighlightedIndex(0);
    setSelectedMentions((prev) => {
      if (prev.some((item) => item.id === candidate.id)) {
        return prev;
      }
      if (prev.length >= MAX_DOCUMENT_COMMENT_MENTIONS) {
        return prev;
      }
      return [...prev, candidate];
    });

    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === "function") {
          el.setSelectionRange(nextCaretPosition, nextCaretPosition);
        }
      }
    });
  };

  const handleTriggerMentionClick = (): void => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insertion = needsLeadingSpace ? " @" : "@";
    const nextText = `${before}${insertion}${body.slice(caret)}`;
    const nextCaret = before.length + insertion.length;

    setBody(nextText.slice(0, MAX_DOCUMENT_COMMENT_LENGTH));
    setActiveToken(detectActiveMentionToken(nextText, nextCaret));
    setHighlightedIndex(0);

    requestAnimationFrame(() => {
      const target = inputRef.current;
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === "function") {
          target.setSelectionRange(nextCaret, nextCaret);
        }
      }
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!activeToken || candidates.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % candidates.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      const chosen = candidates[activeCandidateIndex];
      if (chosen) {
        event.preventDefault();
        applyMentionCandidate(chosen);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setActiveToken(null);
    }
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed.length === 0 || isDeletedDocument) {
      return;
    }

    setFeedback(null);
    try {
      await createMutation.mutateAsync({
        body: trimmed,
        mentionedUserIds: activeSelectedMentions.map((item) => item.id),
      });
      setBody("");
      setSelectedMentions([]);
      setActiveToken(null);
      setFeedback({
        severity: "success",
        message: t("documents.comments.createSuccess"),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : t("documents.comments.errors.createFailed"),
      });
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!commentToDelete) {
      return;
    }
    try {
      await deleteMutation.mutateAsync(commentToDelete.id);
      setCommentToDelete(null);
      setFeedback({
        severity: "success",
        message: t("documents.comments.deleteSuccess"),
      });
    } catch (error) {
      setCommentToDelete(null);
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : t("documents.comments.errors.deleteFailed"),
      });
    }
  };

  const totalCount = commentsQuery.data?.pagination.totalItems ?? 0;
  const totalPages = commentsQuery.data?.pagination.totalPages ?? 1;
  const comments = commentsQuery.data?.items ?? [];

  return (
    <Paper
      component="section"
      aria-label={t("documents.comments.heading")}
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
      }}
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center">
            <CommentOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="h6" component="h2">
              {t("documents.comments.heading")}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={t("documents.comments.countLabel", { count: formatNumber(totalCount) })}
            />
          </Stack>
        </Stack>

        <Divider />

        {feedback ? (
          <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        ) : null}

        {isDeletedDocument ? (
          <Alert severity="info">{t("documents.comments.deletedReadOnlyNotice")}</Alert>
        ) : (
          <Box
            component="form"
            onSubmit={(event) => void handleSubmit(event)}
            sx={{ position: "relative" }}
          >
            <Stack spacing={1.25}>
              <TextField
                inputRef={inputRef}
                label={t("documents.comments.inputLabel")}
                placeholder={t("documents.comments.inputPlaceholder")}
                helperText={t("documents.comments.mentionHelper")}
                value={body}
                onChange={handleBodyChange}
                onKeyDown={handleInputKeyDown}
                multiline
                minRows={2}
                maxRows={6}
                fullWidth
                disabled={createMutation.isPending}
                inputProps={{ maxLength: MAX_DOCUMENT_COMMENT_LENGTH }}
              />

              {activeToken ? (
                <Paper
                  elevation={3}
                  variant="outlined"
                  sx={{
                    borderColor: PAPYRUS_COLOR_TOKENS.primary.main,
                    bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                    maxHeight: 240,
                    overflowY: "auto",
                  }}
                >
                  {mentionQuery.isLoading ? (
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
                      <CircularProgress size={16} />
                      <Typography variant="body2" color="text.secondary">
                        {t("documents.comments.searchingMentions")}
                      </Typography>
                    </Stack>
                  ) : candidates.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                      {t("documents.comments.noMentionMatches")}
                    </Typography>
                  ) : (
                    <List
                      dense
                      disablePadding
                      aria-label={t("documents.comments.mentionsListAria")}
                    >
                      {candidates.map((candidate, index) => (
                        <ListItemButton
                          key={candidate.id}
                          aria-current={index === activeCandidateIndex ? "true" : undefined}
                          selected={index === activeCandidateIndex}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applyMentionCandidate(candidate);
                          }}
                        >
                          <Avatar
                            sx={{
                              width: 28,
                              height: 28,
                              mr: 1.5,
                              fontSize: "0.75rem",
                              bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
                              color: PAPYRUS_COLOR_TOKENS.primary.onContainer,
                            }}
                          >
                            {getInitials(candidate.fullName)}
                          </Avatar>
                          <ListItemText
                            primary={candidate.fullName}
                            secondary={candidate.email}
                            primaryTypographyProps={{ variant: "body2", fontWeight: 500 }}
                            secondaryTypographyProps={{ variant: "caption" }}
                          />
                        </ListItemButton>
                      ))}
                    </List>
                  )}
                </Paper>
              ) : null}

              {activeSelectedMentions.length > 0 ? (
                <Stack
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  flexWrap="wrap"
                  useFlexGap
                >
                  <Typography variant="caption" color="text.secondary">
                    {t("documents.comments.selectedMentionsLabel")}
                  </Typography>
                  {activeSelectedMentions.map((mention) => (
                    <Chip
                      key={mention.id}
                      size="small"
                      label={`@${mention.fullName}`}
                      color="primary"
                      variant="outlined"
                    />
                  ))}
                </Stack>
              ) : null}

              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 1,
                  flexWrap: "wrap",
                }}
              >
                <Button
                  type="button"
                  size="small"
                  variant="text"
                  startIcon={<AlternateEmailOutlinedIcon />}
                  onClick={handleTriggerMentionClick}
                  disabled={createMutation.isPending}
                >
                  {t("documents.comments.mentionButton")}
                </Button>

                <Button
                  type="submit"
                  variant="contained"
                  size="small"
                  startIcon={
                    createMutation.isPending ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <SendOutlinedIcon />
                    )
                  }
                  disabled={createMutation.isPending || body.trim().length === 0}
                >
                  {createMutation.isPending
                    ? t("documents.comments.submitting")
                    : t("documents.comments.submit")}
                </Button>
              </Box>
            </Stack>
          </Box>
        )}

        {commentsQuery.isLoading ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              {t("documents.comments.loading")}
            </Typography>
          </Stack>
        ) : commentsQuery.isError ? (
          <ErrorState
            title={t("documents.comments.errors.loadFailed")}
            description={commentsQuery.error.message}
            onRetry={() => void commentsQuery.refetch()}
          />
        ) : comments.length === 0 ? (
          <Box
            sx={{
              p: 2,
              borderRadius: 1.5,
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            }}
          >
            <Typography variant="subtitle2" gutterBottom>
              {t("documents.comments.emptyTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("documents.comments.emptyDescription")}
            </Typography>
          </Box>
        ) : (
          <Stack spacing={1.5}>
            {comments.map((comment) => (
              <Paper
                key={comment.id}
                variant="outlined"
                sx={{
                  p: 1.75,
                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                  borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                }}
              >
                <Stack spacing={1}>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 1,
                    }}
                  >
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <Avatar
                        sx={{
                          width: 32,
                          height: 32,
                          fontSize: "0.8rem",
                          bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
                          color: PAPYRUS_COLOR_TOKENS.primary.onContainer,
                        }}
                      >
                        {getInitials(comment.author.fullName)}
                      </Avatar>
                      <Box>
                        <Typography variant="body2" fontWeight={600}>
                          {comment.author.fullName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDateTime(comment.createdAt)}
                        </Typography>
                      </Box>
                    </Stack>

                    {comment.canDelete ? (
                      <Tooltip title={t("documents.comments.deleteAction")}>
                        <IconButton
                          size="small"
                          aria-label={t("documents.comments.deleteAction")}
                          onClick={() => setCommentToDelete(comment)}
                          disabled={deleteMutation.isPending}
                        >
                          <DeleteOutlineOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                  </Box>

                  <Typography
                    variant="body2"
                    sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}
                  >
                    {renderCommentBodyWithMentions(comment.body, comment.mentions)}
                  </Typography>
                </Stack>
              </Paper>
            ))}

            {totalPages > 1 ? (
              <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="flex-end">
                <Button
                  size="small"
                  variant="outlined"
                  disabled={page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  {t("documents.comments.previousPage")}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  {t("documents.comments.pageIndicator", {
                    page: formatNumber(page),
                    totalPages: formatNumber(totalPages),
                  })}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={page >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  {t("documents.comments.nextPage")}
                </Button>
              </Stack>
            ) : null}
          </Stack>
        )}
      </Stack>

      <ConfirmDialog
        open={commentToDelete !== null}
        title={t("documents.comments.deleteDialogTitle")}
        description={t("documents.comments.deleteDialogDescription")}
        confirmLabel={t("documents.comments.deleteAction")}
        confirmColor="error"
        loading={deleteMutation.isPending}
        onCancel={() => setCommentToDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </Paper>
  );
}
