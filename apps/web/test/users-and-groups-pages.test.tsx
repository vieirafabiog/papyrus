import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupsPage } from "../src/features/admin/GroupsPage.js";
import { UsersPage } from "../src/features/admin/UsersPage.js";
import { I18nProvider } from "../src/i18n/index.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const USER_2_ID = "550e8400-e29b-41d4-a716-446655440012";
const GROUP_1_ID = "550e8400-e29b-41d4-a716-446655440021";

function buildSessionPayload(roles: string[]) {
  return {
    data: {
      user: {
        id: USER_1_ID,
        organizationId: ORG_ID,
        email: "admin@papyrus.local",
        fullName: "Admin Principal",
        status: "ACTIVE",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
      groups: [],
      roles: roles.map((key, idx) => ({
        id: `550e8400-e29b-41d4-a716-44665544009${idx}`,
        key,
        name: key,
        description: null,
        isSystem: true,
      })),
      permissions: [],
      sessionExpiresAt: "2026-12-31T10:00:00.000Z",
    },
  };
}

function renderWithProviders(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <I18nProvider initialLocale="en-US">
      <UiLocaleProvider locale="en-US">
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>{element}</MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("UsersPage and GroupsPage (Step 14.02)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("blocks unauthorized users from administering users", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(buildSessionPayload(["collaborator"])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderWithProviders(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByText("Access restricted")).toBeInTheDocument();
    });
  });

  it("filters, creates, edits, and deactivates users", async () => {
    const usersList = [
      {
        id: USER_1_ID,
        organizationId: ORG_ID,
        email: "admin@papyrus.local",
        fullName: "Admin Principal",
        status: "ACTIVE",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(buildSessionPayload(["admin"])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-users" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/users") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ data: usersList }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/users") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { fullName: string; email: string };
        const created = {
          id: USER_2_ID,
          organizationId: ORG_ID,
          email: body.email,
          fullName: body.fullName,
          status: "ACTIVE",
          createdAt: "2026-01-02T10:00:00.000Z",
          updatedAt: "2026-01-02T10:00:00.000Z",
        };
        usersList.push(created);
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/api/v1/admin/users/${USER_2_ID}`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { fullName: string };
        const existing = usersList[1];
        if (!existing) {
          throw new Error("Expected second user in test harness");
        }
        usersList[1] = { ...existing, fullName: body.fullName };
        return new Response(JSON.stringify({ data: usersList[1] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/api/v1/admin/users/${USER_2_ID}/deactivate`)) {
        const existing = usersList[1];
        if (!existing) {
          throw new Error("Expected second user in test harness");
        }
        usersList[1] = { ...existing, status: "INACTIVE" };
        return new Response(JSON.stringify({ data: usersList[1] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    renderWithProviders(<UsersPage />);

    await waitFor(() => {
      expect(screen.getByText("Admin Principal")).toBeInTheDocument();
    });

    // Create new user
    fireEvent.click(screen.getByRole("button", { name: "New user" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText(/Full name/i), {
      target: { value: "Mariana Souza" },
    });
    fireEvent.change(within(createDialog).getByLabelText(/Work email/i), {
      target: { value: "mariana@papyrus.local" },
    });
    fireEvent.change(within(createDialog).getByLabelText(/Initial password/i), {
      target: { value: "SenhaSegura!2026" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create user" }));

    await waitFor(() => {
      expect(screen.getByText('User "Mariana Souza" created.')).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Edit user
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mariana Souza" }));
    const editDialog = await screen.findByRole("dialog");
    fireEvent.change(within(editDialog).getByLabelText(/Full name/i), {
      target: { value: "Mariana Costa" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText('User "Mariana Costa" updated.')).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Deactivate user
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Mariana Costa" }));
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Deactivate account" }));

    await waitFor(() => {
      expect(screen.getByText('User "Mariana Costa" deactivated.')).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Filter by search
    fireEvent.change(screen.getByLabelText("Search users"), {
      target: { value: "Mariana" },
    });
    expect(screen.getByText("Mariana Costa")).toBeInTheDocument();
    expect(screen.queryByText("Admin Principal")).not.toBeInTheDocument();
  });

  it("creates groups and associates/removes members", async () => {
    const groupsList = [
      {
        id: GROUP_1_ID,
        organizationId: ORG_ID,
        name: "Jurídico",
        description: "Revisores de contratos",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ];
    let membersList: Array<{
      id: string;
      organizationId: string;
      email: string;
      fullName: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }> = [];
    const orgUsers = [
      {
        id: USER_2_ID,
        organizationId: ORG_ID,
        email: "analista@papyrus.local",
        fullName: "Carlos Analista",
        status: "ACTIVE",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(buildSessionPayload(["admin"])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-groups" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/groups") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ data: groupsList }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/groups") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; description?: string | null };
        const created = {
          id: "550e8400-e29b-41d4-a716-446655440022",
          organizationId: ORG_ID,
          name: body.name,
          description: body.description ?? null,
          createdAt: "2026-01-02T10:00:00.000Z",
          updatedAt: "2026-01-02T10:00:00.000Z",
        };
        groupsList.push(created);
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/users")) {
        return new Response(JSON.stringify({ data: orgUsers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.endsWith(`/api/v1/admin/groups/${GROUP_1_ID}/members`) &&
        (!init?.method || init.method === "GET")
      ) {
        return new Response(JSON.stringify({ data: membersList }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/api/v1/admin/groups/${GROUP_1_ID}/members`) && init?.method === "POST") {
        const firstUser = orgUsers[0];
        membersList = firstUser ? [firstUser] : [];
        return new Response(JSON.stringify({ data: { linked: true } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.endsWith(`/api/v1/admin/groups/${GROUP_1_ID}/members/${USER_2_ID}`) &&
        init?.method === "DELETE"
      ) {
        membersList = [];
        return new Response(JSON.stringify({ data: { removed: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    renderWithProviders(<GroupsPage />);

    await waitFor(() => {
      expect(screen.getByText("Jurídico")).toBeInTheDocument();
    });

    // Create group
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText(/Group name/i), {
      target: { value: "Compliance" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create group" }));

    await waitFor(() => {
      expect(screen.getByText('Group "Compliance" created.')).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Open group members dialog and associate user
    fireEvent.click(await screen.findByRole("button", { name: "Manage members of Jurídico" }));
    const membersDialog = await screen.findByRole("dialog");
    const selectInput = within(membersDialog).getByLabelText(/Add active user/i);
    fireEvent.mouseDown(selectInput);
    const option = await screen.findByRole("option", { name: /Carlos Analista/i });
    fireEvent.click(option);
    fireEvent.click(within(membersDialog).getByRole("button", { name: "Add member" }));

    await waitFor(() => {
      expect(screen.getByText('User added to group "Jurídico".')).toBeInTheDocument();
    });

    // Remove member
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Remove Carlos Analista from group" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove Carlos Analista from group" }));
    const confirmRemove = await screen.findByRole("button", { name: "Remove member" });
    fireEvent.click(confirmRemove);

    await waitFor(() => {
      expect(
        screen.getByText('User "Carlos Analista" removed from group "Jurídico".'),
      ).toBeInTheDocument();
    });
  });
});
