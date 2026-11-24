import type { TagRecord } from "@docuflow/contracts";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import LabelOutlinedIcon from "@mui/icons-material/LabelOutlined";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import {
  useAttachDocumentTagMutation,
  useCreateTagMutation,
  useDetachDocumentTagMutation,
  useDocumentTagsQuery,
  useTagsQuery,
} from "./useTagsApi.js";

export interface DocumentTagsFieldProps {
  readonly documentId: string;
  readonly canEdit: boolean;
}

/**
 * Interactive MD3-aligned chip and picker control to view, create, attach, and detach document tags.
 */
export function DocumentTagsField({ documentId, canEdit }: DocumentTagsFieldProps) {
  const { t } = useI18n();
  const [selectedTag, setSelectedTag] = useState<TagRecord | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const documentTagsQuery = useDocumentTagsQuery(documentId);
  const availableTagsQuery = useTagsQuery("");
  const createTagMutation = useCreateTagMutation();
  const attachMutation = useAttachDocumentTagMutation(documentId);
  const detachMutation = useDetachDocumentTagMutation(documentId);

  const attachedTags = documentTagsQuery.data ?? [];
  const attachedIds = useMemo(() => new Set(attachedTags.map((tag) => tag.id)), [attachedTags]);

  const unattachedOptions = useMemo(() => {
    const allTags = availableTagsQuery.data?.items ?? [];
    return allTags.filter((tag) => !attachedIds.has(tag.id));
  }, [attachedIds, availableTagsQuery.data]);

  const isBusy =
    createTagMutation.isPending || attachMutation.isPending || detachMutation.isPending;

  const handleAttachSelected = async () => {
    if (!selectedTag) {
      return;
    }
    setFeedbackError(null);
    try {
      await attachMutation.mutateAsync(selectedTag.id);
      setSelectedTag(null);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setFeedbackError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("tags.field.attachFailed"),
      );
    }
  };

  const handleCreateAndAttach = async () => {
    const trimmed = newTagName.trim();
    if (trimmed.length === 0) {
      setFeedbackError(t("tags.field.newNameRequired"));
      return;
    }
    setFeedbackError(null);
    try {
      const created = await createTagMutation.mutateAsync({ name: trimmed });
      await attachMutation.mutateAsync(created.id);
      setNewTagName("");
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setFeedbackError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("tags.page.createFailed"),
      );
    }
  };

  const handleDetach = async (tagId: string) => {
    setFeedbackError(null);
    try {
      await detachMutation.mutateAsync(tagId);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setFeedbackError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("tags.field.detachFailed"),
      );
    }
  };

  return (
    <Stack spacing={1.5} aria-label={t("tags.field.ariaLabel")}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <LabelOutlinedIcon fontSize="small" color="action" />
        <Typography variant="subtitle2">{t("tags.field.heading")}</Typography>
        {(documentTagsQuery.isLoading || isBusy) && <CircularProgress size={16} />}
      </Stack>

      {documentTagsQuery.isError ? (
        <Alert severity="error">{documentTagsQuery.error.message}</Alert>
      ) : null}

      {feedbackError ? (
        <Alert severity="error" onClose={() => setFeedbackError(null)}>
          {feedbackError}
        </Alert>
      ) : null}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {attachedTags.length === 0 && !documentTagsQuery.isLoading ? (
          <Typography variant="body2" color="text.secondary">
            {t("tags.field.empty")}
          </Typography>
        ) : (
          attachedTags.map((tag) => (
            <Chip
              key={tag.id}
              label={tag.name}
              variant="outlined"
              size="small"
              onDelete={canEdit ? () => void handleDetach(tag.id) : undefined}
              disabled={isBusy}
              sx={
                tag.color
                  ? {
                      borderColor: tag.color,
                      "& .MuiChip-label": { fontWeight: 500 },
                    }
                  : undefined
              }
            />
          ))
        )}
      </Box>

      {canEdit ? (
        <Stack spacing={1.25}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
            <Autocomplete
              size="small"
              sx={{ minWidth: 240, flex: 1 }}
              options={unattachedOptions}
              value={selectedTag}
              onChange={(_event, value) => setSelectedTag(value)}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              noOptionsText={t("tags.field.noOptions")}
              renderInput={(params) => (
                <TextField {...params} label={t("tags.field.attachExistingLabel")} />
              )}
            />
            <Button
              variant="outlined"
              disabled={!selectedTag || isBusy}
              onClick={() => void handleAttachSelected()}
            >
              {t("tags.field.attachButton")}
            </Button>
          </Stack>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
            <TextField
              size="small"
              label={t("tags.field.createAndAttachLabel")}
              placeholder={t("tags.field.createAndAttachPlaceholder")}
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
              disabled={isBusy}
              sx={{ flex: 1 }}
            />
            <Button
              variant="contained"
              startIcon={<AddOutlinedIcon />}
              disabled={isBusy || newTagName.trim().length === 0}
              onClick={() => void handleCreateAndAttach()}
            >
              {t("tags.field.createButton")}
            </Button>
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}
