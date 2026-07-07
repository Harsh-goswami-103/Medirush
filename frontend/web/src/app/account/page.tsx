"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, CreateAddressBody, UpdateMeBody, User } from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/toast";
import { TopBar } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { Field, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";

export default function AccountPage() {
  const router = useRouter();
  const { user, loading, logout, refreshUser } = useAuth();
  const { store } = useStore();
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Address | null>(null);

  // Seed the editable profile fields once the session resolves.
  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setEmail(user.email ?? "");
    }
  }, [user]);

  const addrQuery = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<Address[]>("/v1/addresses"),
    enabled: Boolean(user),
  });

  const saveProfile = useMutation({
    mutationFn: () => {
      const body: UpdateMeBody = {};
      const n = name.trim();
      const e = email.trim();
      if (n && n !== (user?.name ?? "")) body.name = n;
      if (e !== (user?.email ?? "")) body.email = e === "" ? null : e;
      return api.patch<User>("/v1/me", body);
    },
    onSuccess: (res) => {
      setName(res.data.name ?? "");
      setEmail(res.data.email ?? "");
      // Refresh the cached auth user so the form is no longer "dirty" post-save.
      void refreshUser();
      toast.push({ type: "success", message: "Profile saved" });
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not save profile",
      }),
  });

  const deleteAddr = useMutation({
    mutationFn: (addrId: string) => api.del(`/v1/addresses/${addrId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["addresses"] });
      toast.push({ type: "success", message: "Address deleted" });
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not delete address",
      }),
  });

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div>
        <TopBar title="Account" />
        <div className="space-y-3 p-4">
          <EmptyState
            title="You’re not signed in"
            hint="Sign in to manage your profile, addresses and orders."
          />
          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-input bg-primary-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const addresses = addrQuery.data?.data ?? [];
  const profileDirty =
    name.trim() !== (user.name ?? "") || email.trim() !== (user.email ?? "");

  function confirmDelete(addrId: string) {
    if (typeof window !== "undefined" && !window.confirm("Delete this address?")) return;
    deleteAddr.mutate(addrId);
  }

  return (
    <div>
      <TopBar title="Account" />

      <div className="space-y-4 p-4">
        {/* -------------------------------------------------------- profile */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Profile</h2>
          <div className="space-y-3">
            <Field label="Name" error={name.trim() === "" ? "Name can't be empty" : undefined}>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </Field>
            <Field label="Email" hint="Used for order receipts and invoices.">
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Phone" hint="Linked to your sign-in; contact support to change it.">
              <TextInput value={user.phone} disabled readOnly />
            </Field>
            <Button
              onClick={() => saveProfile.mutate()}
              disabled={!profileDirty || name.trim() === ""}
              loading={saveProfile.isPending}
            >
              Save changes
            </Button>
          </div>
        </Card>

        {/* ------------------------------------------------------ addresses */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink-900">Saved addresses</h2>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Add
            </Button>
          </div>

          {addrQuery.isError ? (
            <ErrorState
              message={(addrQuery.error as Error).message}
              onRetry={() => addrQuery.refetch()}
            />
          ) : addrQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5 text-primary-600" />
            </div>
          ) : addresses.length === 0 ? (
            <EmptyState title="No saved addresses" hint="Add one to speed up checkout." />
          ) : (
            <ul className="space-y-2">
              {addresses.map((a) => (
                <li key={a.id} className="rounded-input border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                        {a.label}
                        {a.isDefault && <Badge tone="teal">Default</Badge>}
                      </p>
                      <p className="text-sm text-ink-600">
                        {a.line1}
                        {a.line2 ? `, ${a.line2}` : ""}
                      </p>
                      {a.landmark && <p className="text-xs text-ink-400">Near {a.landmark}</p>}
                      <p className="text-xs text-ink-400">PIN {a.pincode}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditing(a);
                          setFormOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-danger"
                        loading={deleteAddr.isPending && deleteAddr.variables === a.id}
                        onClick={() => confirmDelete(a.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* -------------------------------------------------------- sign out */}
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            logout();
            router.push("/");
          }}
        >
          Sign out
        </Button>

        {/* -------------------------------------------- regulatory (§10.2) */}
        <footer className="px-1 pt-2 text-center text-[11px] leading-5 text-ink-400">
          <p>Drug License: {store?.drugLicenseNo ?? "—"}</p>
          <p>
            Pharmacist: {store?.pharmacistName ?? "—"} (Reg. {store?.pharmacistRegNo ?? "—"})
          </p>
          <p>GSTIN: {store?.gstin ?? "—"}</p>
          <p>FSSAI: {store?.fssaiNo ?? "—"}</p>
        </footer>
      </div>

      <AddressFormModal open={formOpen} initial={editing} onClose={() => setFormOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------ address add/edit modal */

function AddressFormModal({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Address | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const [label, setLabel] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [landmark, setLandmark] = useState("");
  const [pincode, setPincode] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  // Re-seed the form whenever it opens or the target address changes.
  useEffect(() => {
    setLabel(initial?.label ?? "");
    setLine1(initial?.line1 ?? "");
    setLine2(initial?.line2 ?? "");
    setLandmark(initial?.landmark ?? "");
    setPincode(initial?.pincode ?? "");
    setLat(initial ? String(initial.lat) : "");
    setLng(initial ? String(initial.lng) : "");
  }, [initial, open]);

  const save = useMutation({
    mutationFn: () => {
      const body: CreateAddressBody = {
        label: label.trim() || undefined,
        line1: line1.trim(),
        line2: line2.trim() || undefined,
        landmark: landmark.trim() || undefined,
        pincode: pincode.trim(),
        lat: Number(lat),
        lng: Number(lng),
      };
      return initial
        ? api.patch<Address>(`/v1/addresses/${initial.id}`, body)
        : api.post<Address>("/v1/addresses", body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["addresses"] });
      toast.push({ type: "success", message: initial ? "Address updated" : "Address added" });
      onClose();
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not save address",
      }),
  });

  const latNum = Number(lat);
  const lngNum = Number(lng);
  const latOk = lat.trim() !== "" && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90;
  const lngOk = lng.trim() !== "" && Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180;
  const pinOk = /^[1-9]\d{5}$/.test(pincode.trim());
  const valid = line1.trim().length > 0 && pinOk && latOk && lngOk;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? "Edit address" : "Add address"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>
            {initial ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label" hint="e.g. Home, Work">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home" />
        </Field>
        <Field label="Address line 1">
          <TextInput
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            placeholder="Flat / house no, building, street"
          />
        </Field>
        <Field label="Address line 2">
          <TextInput
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
            placeholder="Area, locality (optional)"
          />
        </Field>
        <Field label="Landmark">
          <TextInput
            value={landmark}
            onChange={(e) => setLandmark(e.target.value)}
            placeholder="Nearby landmark (optional)"
          />
        </Field>
        <Field label="PIN code" error={pincode.trim() !== "" && !pinOk ? "Enter a valid 6-digit PIN" : undefined}>
          <TextInput
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
            inputMode="numeric"
            maxLength={6}
            placeholder="560001"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude">
            <TextInput
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              inputMode="decimal"
              placeholder="12.97160"
            />
          </Field>
          <Field label="Longitude">
            <TextInput
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              inputMode="decimal"
              placeholder="77.59456"
            />
          </Field>
        </div>
        <p className={cn("text-xs text-ink-400")}>
          Drop a pin at your door for accurate delivery. Coordinates come from the map in
          production.
        </p>
      </div>
    </Modal>
  );
}
