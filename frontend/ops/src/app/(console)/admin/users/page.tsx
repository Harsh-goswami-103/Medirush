"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role, type AdminUser, type RiskFlag } from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Select, Table, THead, Th, Tr, Td, TextInput } from "@/components/kit";
import { useToast } from "@/components/toast";

const ROLES = Object.values(Role);

const ROLE_TONE = {
  CUSTOMER: "neutral",
  DRIVER: "blue",
  INVENTORY: "teal",
  ADMIN: "violet",
} as const satisfies Record<Role, string>;

const RISK_TONE = {
  NONE: "neutral",
  WATCH: "amber",
  COD_BLOCKED: "amber",
  BLOCKED: "red",
} as const satisfies Record<RiskFlag, string>;

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [role, setRole] = useState<"" | Role>("");
  const [blocked, setBlocked] = useState<"" | "true" | "false">("");

  const query = useQuery({
    queryKey: ["admin-users", { search, role, blocked }],
    queryFn: () =>
      api.get<AdminUser[]>(`/v1/admin/users${qs({ search, role, blocked, limit: 50 })}`),
  });
  const users = query.data?.data ?? [];

  const onError = (e: unknown) =>
    toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["admin-users"] });

  const blockMut = useMutation({
    mutationFn: (vars: { id: string; blocked: boolean }) =>
      api.post<AdminUser>(`/v1/admin/users/${vars.id}/block`, { blocked: vars.blocked }),
    onSuccess: (_res, vars) => {
      invalidate();
      toast.push({ type: "success", message: vars.blocked ? "User blocked" : "User unblocked" });
    },
    onError,
  });

  const roleMut = useMutation({
    mutationFn: (vars: { id: string; role: Role }) =>
      api.post<AdminUser>(`/v1/admin/users/${vars.id}/role`, { role: vars.role }),
    onSuccess: () => {
      invalidate();
      toast.push({ type: "success", message: "Role updated" });
    },
    onError,
  });

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Manage team roles and customer access."
        actions={query.isFetching ? <Spinner className="h-4 w-4 text-ink-400" /> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TextInput
          className="w-64"
          placeholder="Search phone or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-44" value={role} onChange={(e) => setRole(e.target.value as "" | Role)}>
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Select
          className="w-44"
          value={blocked}
          onChange={(e) => setBlocked(e.target.value as "" | "true" | "false")}
        >
          <option value="">All accounts</option>
          <option value="false">Active only</option>
          <option value="true">Blocked only</option>
        </Select>
      </div>

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState title="No users found" hint="Adjust the filters above." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Phone</Th>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Blocked</Th>
              <Th>Risk</Th>
              <Th right>COD refusals</Th>
              <Th>Joined</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <tbody>
            {users.map((u) => {
              const blocking = blockMut.isPending && blockMut.variables?.id === u.id;
              const changingRole = roleMut.isPending && roleMut.variables?.id === u.id;
              const rowBusy = blocking || changingRole;
              return (
                <Tr key={u.id}>
                  <Td>
                    <div className="font-medium text-ink-900 tabular-nums">{u.phone}</div>
                    {u.email && <div className="text-xs text-ink-400">{u.email}</div>}
                  </Td>
                  <Td>{u.name ?? "—"}</Td>
                  <Td>
                    <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                  </Td>
                  <Td>
                    {u.isBlocked ? (
                      <Badge tone="red">Blocked</Badge>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </Td>
                  <Td>
                    {u.riskFlag === "NONE" ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <Badge tone={RISK_TONE[u.riskFlag]}>{u.riskFlag.replace(/_/g, " ")}</Badge>
                    )}
                  </Td>
                  <Td right>{u.codRefusalCount}</Td>
                  <Td className="whitespace-nowrap text-ink-600">{formatDateTime(u.createdAt)}</Td>
                  <Td className="align-middle">
                    <div className="flex items-center gap-2">
                      {u.isBlocked ? (
                        <Button
                          variant="secondary"
                          className="px-2.5 py-1"
                          disabled={rowBusy}
                          loading={blocking}
                          onClick={() => blockMut.mutate({ id: u.id, blocked: false })}
                        >
                          Unblock
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          className="px-2.5 py-1 text-danger"
                          disabled={rowBusy}
                          loading={blocking}
                          onClick={() => blockMut.mutate({ id: u.id, blocked: true })}
                        >
                          Block
                        </Button>
                      )}
                      <Select
                        className="w-36"
                        value={u.role}
                        disabled={rowBusy}
                        onChange={(e) => roleMut.mutate({ id: u.id, role: e.target.value as Role })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
