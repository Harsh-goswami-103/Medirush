"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, CreateAddressBody, UpdateMeBody, User } from "@medrush/contracts";
import { api, ApiError, apiErrorMessage } from "@/lib/api";
import { whatsappUrl } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/toast";
import { NotificationBell } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Spinner, WhatsAppIcon } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { Field, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";

/* -------------------------------------------------------------- glyphs */

const ICONS = {
  chevron: ["M9 6l6 6-6 6"],
  heart: ["M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 10-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 000-7.8z"],
  clock: ["M21 12a9 9 0 11-18 0 9 9 0 0118 0z", "M12 7.5V12l3 2"],
  tag: [
    "M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7A2 2 0 013 12.2V5a2 2 0 012-2h7.2a2 2 0 011.4.6l7 7a2 2 0 010 2.8z",
    "M7.5 7.5h.01",
  ],
  gift: ["M20 12v9H4v-9", "M2 7h20v5H2z", "M12 22V7", "M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z", "M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"],
  pin: ["M12 21s7-5.3 7-11a7 7 0 10-14 0c0 5.7 7 11 7 11z", "M12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"],
  users: [
    "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2",
    "M9 11a4 4 0 100-8 4 4 0 000 8z",
    "M22 21v-2a4 4 0 00-3-3.87",
    "M16 3.13a4 4 0 010 7.75",
  ],
  file: ["M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z", "M14 2v6h6", "M9 13h6", "M9 17h4"],
  bell: ["M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9", "M13.73 21a2 2 0 01-3.46 0"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  phone: [
    "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0122 16.92z",
  ],
  logout: ["M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  pencil: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"],
} as const;

function Glyph({ paths, className }: { paths: readonly string[]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------ primitives */

function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl2 bg-surface shadow-card2", className)}>
      {children}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </h2>
  );
}

function NavRow({
  href,
  paths,
  label,
  hint,
  tone = "teal",
}: {
  href: string;
  paths: readonly string[];
  label: string;
  hint?: string;
  tone?: "teal" | "amber";
}) {
  return (
    <Link
      href={href}
      className="press flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors hover:bg-primary-50/60"
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
          tone === "amber" ? "bg-accent/10 text-accent" : "bg-primary-50 text-primary-700",
        )}
      >
        <Glyph paths={paths} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-400">{hint}</span>}
      </span>
      <Glyph paths={ICONS.chevron} className="h-4 w-4 shrink-0 text-ink-400" />
    </Link>
  );
}

function QuickTile({
  href,
  paths,
  label,
  hint,
  tone = "teal",
}: {
  href: string;
  paths: readonly string[];
  label: string;
  hint: string;
  tone?: "teal" | "amber";
}) {
  return (
    <Link href={href} className="press rounded-xl2 bg-surface p-3.5 shadow-card2">
      <span
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-xl",
          tone === "amber" ? "bg-accent/10 text-accent" : "bg-primary-50 text-primary-700",
        )}
      >
        <Glyph paths={paths} />
      </span>
      <span className="mt-2.5 block text-sm font-semibold text-ink-900">{label}</span>
      <span className="block text-xs text-ink-400">{hint}</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ page */

export default function AccountPage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const { store } = useStore();
  const qc = useQueryClient();
  const toast = useToast();

  const [profileOpen, setProfileOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Address | null>(null);
  const [deleting, setDeleting] = useState<Address | null>(null);

  const addrQuery = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<Address[]>("/v1/addresses"),
    enabled: Boolean(user),
  });

  const deleteAddr = useMutation({
    mutationFn: (addrId: string) => api.del(`/v1/addresses/${addrId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["addresses"] });
      setDeleting(null);
      toast.push({ type: "success", message: "Address deleted" });
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not delete address") }),
  });

  // UpdateAddressBody already accepts `isDefault`; the server clears the
  // previous default in the same transaction.
  const setDefaultAddr = useMutation({
    mutationFn: (addrId: string) =>
      api.patch<Address>(`/v1/addresses/${addrId}`, { isDefault: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["addresses"] });
      toast.push({ type: "success", message: "Default address updated" });
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: apiErrorMessage(err, "Could not set the default address"),
      }),
  });

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-dvh bg-mesh">
        <header className="relative overflow-hidden rounded-b-sheet2 bg-mesh-hero bg-mesh-animated px-4 pb-10 pt-4">
          <div className="absolute inset-0 bg-primary-900/60" aria-hidden />
          <div className="relative">
            <h1 className="text-lg font-semibold text-white">Account</h1>
            <p className="mt-2 text-sm text-white/90">
              Sign in to manage your profile, prescriptions and orders.
            </p>
          </div>
        </header>
        <div className="p-4">
          <EmptyState
            title="You’re not signed in"
            hint="Your addresses, prescriptions and order history live here."
            action={
              <Link
                href="/login"
                className="press inline-flex min-h-11 w-full items-center justify-center rounded-xl2 bg-gradient-to-br from-primary-500 to-primary-700 px-4 text-sm font-semibold text-white shadow-glow"
              >
                Sign in
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const addresses = addrQuery.data?.data ?? [];
  // null when NEXT_PUBLIC_SUPPORT_PHONE is unset — the CTA is hidden then.
  const supportUrl = whatsappUrl("Hi, I need help with my MedRush order.");
  const displayName = user.name?.trim() || "Add your name";
  const initial = (user.name?.trim()?.[0] ?? user.phone.replace(/\D/g, "").slice(-1) ?? "M").toUpperCase();

  return (
    <div className="min-h-dvh bg-mesh pb-8">
      {/* Hero — a flat scrim over the animated mesh keeps every label ≥4.5:1. */}
      <header className="relative overflow-hidden rounded-b-sheet2 bg-mesh-hero bg-mesh-animated px-4 pb-14 pt-4">
        <div className="absolute inset-0 bg-primary-900/60" aria-hidden />
        <div className="relative">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold text-white">Account</h1>
            <NotificationBell tone="invert" />
          </div>

          <div className="mt-5 flex items-center gap-4">
            <span
              aria-hidden
              className="glass-dark flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-bold text-white"
            >
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xl font-semibold text-white">{displayName}</p>
              <p className="mt-0.5 text-sm text-white/90">{user.phone}</p>
              {user.email && <p className="truncate text-sm text-white/90">{user.email}</p>}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="glass-dark press mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl2 text-sm font-semibold text-white"
          >
            <Glyph paths={ICONS.pencil} className="h-4 w-4" />
            Edit profile
          </button>
        </div>
      </header>

      <div className="relative -mt-8 space-y-5 px-4">
        {/* ------------------------------------------------- quick tiles */}
        <Reveal>
          <div className="grid grid-cols-2 gap-3">
            <QuickTile href="/wishlist" paths={ICONS.heart} label="Wishlist" hint="Saved items" />
            <QuickTile href="/refills" paths={ICONS.clock} label="Refills" hint="Reminders" />
            <QuickTile href="/offers" paths={ICONS.tag} label="Offers" hint="Coupons & deals" tone="amber" />
            <QuickTile href="/referrals" paths={ICONS.gift} label="Refer & earn" hint="Invite friends" />
          </div>
        </Reveal>

        {/* ------------------------------------------------- health group */}
        <Reveal delayMs={60}>
          <section>
            <GroupLabel>Your health</GroupLabel>
            <Panel className="divide-y divide-line">
              <NavRow
                href="/profiles"
                paths={ICONS.users}
                label="Patient profiles"
                hint="Order for family and dependants"
              />
              <NavRow
                href="/prescriptions"
                paths={ICONS.file}
                label="My prescriptions"
                hint="Upload once, reuse on every refill"
              />
            </Panel>
          </section>
        </Reveal>

        {/* --------------------------------------------------- addresses */}
        <Reveal delayMs={120}>
          <section>
            <div className="mb-2 flex items-end justify-between gap-2 px-1">
              <GroupLabel>Saved addresses</GroupLabel>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
                className="press -mt-2 min-h-11 rounded-pill px-2 text-xs font-semibold text-primary-700"
              >
                + Add new
              </button>
            </div>

            <div aria-live="polite">
              {addrQuery.isError ? (
                <ErrorState
                  message={(addrQuery.error as Error).message}
                  onRetry={() => addrQuery.refetch()}
                />
              ) : addrQuery.isLoading ? (
                <Panel className="divide-y divide-line">
                  {[0, 1].map((i) => (
                    <div key={i} className="p-4">
                      <Skeleton className="h-4 w-24 rounded" />
                      <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
                      <Skeleton className="mt-1.5 h-3 w-1/3 rounded" />
                    </div>
                  ))}
                </Panel>
              ) : addresses.length === 0 ? (
                <EmptyState
                  icon={<Glyph paths={ICONS.pin} className="h-7 w-7" />}
                  title="No saved addresses"
                  hint="Add one to speed up checkout."
                  action={
                    <Button
                      className="w-full"
                      onClick={() => {
                        setEditing(null);
                        setFormOpen(true);
                      }}
                    >
                      Add an address
                    </Button>
                  }
                />
              ) : (
                <Panel className="divide-y divide-line">
                  {addresses.map((a) => (
                    <div key={a.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-900">
                            {a.label || "Address"}
                            {a.isDefault && <Badge tone="teal">Default</Badge>}
                          </p>
                          <p className="mt-0.5 text-sm text-ink-600">
                            {a.line1}
                            {a.line2 ? `, ${a.line2}` : ""}
                          </p>
                          {a.landmark && <p className="text-xs text-ink-400">Near {a.landmark}</p>}
                          <p className="text-xs text-ink-400">PIN {a.pincode}</p>
                        </div>
                        <span className="flex shrink-0 flex-col items-end">
                          <button
                            type="button"
                            className="press min-h-11 px-2 text-xs font-semibold text-primary-700"
                            onClick={() => {
                              setEditing(a);
                              setFormOpen(true);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="press min-h-11 px-2 text-xs font-semibold text-danger"
                            onClick={() => setDeleting(a)}
                          >
                            Delete
                          </button>
                        </span>
                      </div>
                      {!a.isDefault && (
                        <button
                          type="button"
                          className="press mt-1 min-h-11 text-xs font-semibold text-primary-700 disabled:opacity-50"
                          disabled={setDefaultAddr.isPending}
                          onClick={() => setDefaultAddr.mutate(a.id)}
                        >
                          {setDefaultAddr.isPending && setDefaultAddr.variables === a.id
                            ? "Setting…"
                            : "Set as default"}
                        </button>
                      )}
                    </div>
                  ))}
                </Panel>
              )}
            </div>
          </section>
        </Reveal>

        {/* ------------------------------------------------- preferences */}
        <Reveal delayMs={160}>
          <section>
            <GroupLabel>Preferences</GroupLabel>
            <Panel className="divide-y divide-line">
              <NavRow
                href="/settings/notifications"
                paths={ICONS.bell}
                label="Notification settings"
                hint="Order updates, offers, refill nudges"
              />
            </Panel>
          </section>
        </Reveal>

        {/* --------------------------------------------------- help/legal */}
        <Reveal delayMs={200}>
          <section>
            <GroupLabel>Help & legal</GroupLabel>
            <Panel className="divide-y divide-line">
              <NavRow href="/legal" paths={ICONS.shield} label="Licensing & compliance" />
              <NavRow href="/privacy" paths={ICONS.shield} label="Privacy policy" />
              <NavRow href="/terms" paths={ICONS.shield} label="Terms & conditions" />
            </Panel>
          </section>
        </Reveal>

        {/* Support CTAs — hidden when no support phone is configured. */}
        {(supportUrl || store?.supportPhone) && (
          <div className="flex gap-3">
            {supportUrl && (
              <a
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="press inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl2 border border-success/30 bg-success/5 px-3.5 text-sm font-semibold text-success"
              >
                <WhatsAppIcon />
                WhatsApp
              </a>
            )}
            {store?.supportPhone && (
              <a
                href={`tel:${store.supportPhone}`}
                className="press inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl2 border border-primary-600/30 bg-primary-50 px-3.5 text-sm font-semibold text-primary-700"
              >
                <Glyph paths={ICONS.phone} className="h-4 w-4" />
                Call us
              </a>
            )}
          </div>
        )}

        {/* ------------------------------------------------------ sign out */}
        <button
          type="button"
          onClick={() => {
            logout();
            router.push("/");
          }}
          className="press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl2 bg-surface px-4 text-sm font-semibold text-danger shadow-card2"
        >
          <Glyph paths={ICONS.logout} className="h-4 w-4" />
          Sign out
        </button>

        {/* -------------------------------------------- regulatory (§10.2) */}
        <footer className="px-1 pt-1 text-center text-[11px] leading-5 text-ink-400">
          <p>Drug License: {store?.drugLicenseNo ?? "—"}</p>
          <p>
            Pharmacist: {store?.pharmacistName ?? "—"} (Reg. {store?.pharmacistRegNo ?? "—"})
          </p>
          <p>GSTIN: {store?.gstin ?? "—"}</p>
          <p>FSSAI: {store?.fssaiNo ?? "—"}</p>
        </footer>
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <AddressFormModal open={formOpen} initial={editing} onClose={() => setFormOpen(false)} />

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete address"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={deleteAddr.isPending}
              onClick={() => deleting && deleteAddr.mutate(deleting.id)}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-600">
          Delete <span className="font-medium text-ink-900">{deleting?.label || "this address"}</span>
          ? Orders already placed keep the address they were delivered to.
        </p>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------ profile modal */

function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Re-seed from the session each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
  }, [open, user]);

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
      void refreshUser();
      toast.push({ type: "success", message: "Profile saved" });
      onClose();
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save profile") }),
  });

  const dirty = name.trim() !== (user?.name ?? "") || email.trim() !== (user?.email ?? "");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit profile"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => saveProfile.mutate()}
            disabled={!dirty || name.trim() === ""}
            loading={saveProfile.isPending}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" error={name.trim() === "" ? "Name can’t be empty" : undefined}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
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
          <TextInput value={user?.phone ?? ""} disabled readOnly />
        </Field>
      </div>
    </Modal>
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
        <Field
          label="PIN code"
          error={pincode.trim() !== "" && !pinOk ? "Enter a valid 6-digit PIN" : undefined}
        >
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
        <p className="text-xs text-ink-400">
          Drop a pin at your door for accurate delivery. Coordinates come from the map in production.
        </p>
      </div>
    </Modal>
  );
}
