import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { PAPYRUS_COLOR_TOKENS } from "../theme/tokens.js";

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  readonly icon?: ReactNode;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export function EmptyState({ title, description, icon, actionLabel, onAction }: EmptyStateProps) {
  return (
    <Paper
      sx={{
        p: 4,
        textAlign: "center",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack spacing={1.5} alignItems="center" maxWidth={420} mx="auto">
        <Box sx={{ color: "text.secondary", display: "flex" }} aria-hidden="true">
          {icon ?? <InboxOutlinedIcon fontSize="large" />}
        </Box>
        <Typography variant="h3" component="h2">
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
        {actionLabel && onAction ? (
          <Box pt={0.5}>
            <Button variant="contained" onClick={onAction}>
              {actionLabel}
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}
