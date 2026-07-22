"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RX_MAX_UPLOAD_BYTES } from "@medrush/contracts";
import type {
  LockerPrescription,
  Patient,
  RxFileUrl,
  RxStatus,
  UpdateRxBody,
} from "@medrush/contracts";
import { api, ApiError, apiErrorMessage, qs } from "@/lib/api";
import { API_BASE_URL } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/toast";
import { NotificationBell } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { Field, Select, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";

const PATIENTS_KEY = ["patients"] as const;
const ACCEPTED = "image/*,application/pdf";
/** Single source of truth with the server's multipart fileSize cap. */
const MAX_UPLOAD_MB = Math.floor(RX_MAX_UPLOAD_BYTES / (1024 * 1024));

const RX_LABEL: Record<RxStatus, string> = {
  NA: "Not reviewed yet",
  PENDING: "In review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const RX_TONE = {
  NA: "neutral",
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
} as const satisfies Record<RxStatus, "neutral" | "amber" | "green" | "red">;

function StatusBadge({ status }: { status: RxStatus }) {
  return <Badge tone={RX_TONE[status]}>{RX_LABEL[status]}</Badge>;
}

/* ------------------------------------------------------------------ page */

export default function PrescriptionLockerPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, token, loading: authLoading } = useAuth();

  const [unattachedOnly, setUnattachedOnly] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<LockerPrescription | null>(null);
  const [deleting, setDeleting] = useState<LockerPrescription | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  const listQuery = useInfiniteQuery({
    queryKey: ["prescriptions", unattachedOnly],
    queryFn: ({ pageParam }) =>
      api.get<LockerPrescription[]>(
        `/v1/prescriptions${qs({
          unattached: unattachedOnly ? "true" : undefined,
          cursor: pageParam,
          limit: 20,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
    enabled: Boolean(user),
  });

  // Presigned GET — opened in a new tab, exactly like the invoice link.
  const viewMut = useMutation({
    mutationFn: (id: string) => api.get<RxFileUrl>(`/v1/prescriptions/${id}/file`),
    onSuccess: (res) => window.open(res.data.url, "_blank", "noopener,noreferrer"),
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not open this file") }),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => api.del(`/v1/prescriptions/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["prescriptions"] });
      setDeleting(null);
      toast.push({ type: "success", message: "Prescription deleted" });
    },
    onError: (err) => {
      // 409 = already attached to an order; the pharmacy record must keep it.
      if (err instanceof ApiError && err.status === 409) {
        setDeleteBlocked(
          "This prescription is attached to an order, so it is part of our dispensing record and can’t be deleted. It stays in your locker for reference.",
        );
        return;
      }
      setDeleteBlocked(apiErrorMessage(err, "Could not delete this prescription."));
    },
  });

  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const items = listQuery.data?.pages.flatMap((p) => p.data) ?? [];

  const listStatusMessage = listQuery.isError
    ? "Could not load your prescriptions"
    : listQuery.isLoading
      ? "Loading your prescriptions"
      : items.length === 0
        ? "No prescriptions"
        : `${items.length} ${items.length === 1 ? "prescription" : "prescriptions"}`;

  return (
    <div className="min-h-dvh bg-mesh pb-28">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur">
        <Link href="/account" aria-label="Back to account" className="press -ml-1 p-1 text-ink-600">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="flex-1 truncate text-base font-semibold text-ink-900">My prescriptions</h1>
        <NotificationBell />
      </header>

      <div className="space-y-4 p-4">
        <div className="rounded-xl2 border border-rx/20 bg-rx/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-rx">
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            Your prescription locker
          </p>
          <p className="mt-1 text-sm leading-6 text-ink-600">
            Upload a prescription once and reuse it on every refill. Files are stored privately and
            are only ever seen by our registered pharmacist.
          </p>
        </div>

        {/* Filter chips */}
        <div className="flex gap-2" role="group" aria-label="Filter prescriptions">
          {[
            { label: "All", value: false },
            { label: "Not used yet", value: true },
          ].map((chip) => {
            const active = unattachedOnly === chip.value;
            return (
              <button
                key={chip.label}
                type="button"
                aria-pressed={active}
                onClick={() => setUnattachedOnly(chip.value)}
                className={cn(
                  "press min-h-11 rounded-pill px-4 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary-600 text-white shadow-glow"
                    : "border border-line bg-surface text-ink-600",
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Only a short summary is announced — a live region around the whole
            list would make a screen reader re-read every card on any change. */}
        <p className="sr-only" role="status" aria-live="polite">
          {listStatusMessage}
        </p>

        <div aria-busy={listQuery.isPending || listQuery.isFetching}>
          {listQuery.isError ? (
            <ErrorState
              message={(listQuery.error as Error).message}
              onRetry={() => listQuery.refetch()}
            />
          ) : listQuery.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-xl2 bg-surface p-4 shadow-card2">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="mt-2 h-3 w-48 rounded" />
                  <Skeleton className="mt-3 h-9 w-full rounded-xl" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  viewBox="0 0 24 24"
                  className="h-8 w-8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 13h6" />
                  <path d="M9 17h4" />
                </svg>
              }
              title={unattachedOnly ? "Nothing unused right now" : "No prescriptions yet"}
              hint={
                unattachedOnly
                  ? "Every prescription in your locker is already attached to an order."
                  : "Upload a photo or PDF and we’ll keep it ready for your next order."
              }
              action={
                <Button className="w-full" onClick={() => setUploadOpen(true)}>
                  Upload a prescription
                </Button>
              }
            />
          ) : (
            <ul className="space-y-3">
              {items.map((rx, i) => (
                <Reveal as="li" key={rx.id} delayMs={Math.min(i, 5) * 40}>
                  <article className="rounded-xl2 bg-surface p-4 shadow-card2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold text-ink-900">
                          {rx.label || "Prescription"}
                        </h2>
                        <p className="mt-0.5 text-xs text-ink-400">
                          Uploaded {formatDateTime(rx.createdAt)}
                        </p>
                      </div>
                      <StatusBadge status={rx.status} />
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge tone="violet">For {rx.patientName ?? "you"}</Badge>
                      {rx.doctorName && <Badge tone="neutral">Dr {rx.doctorName}</Badge>}
                      {/* Negative margin keeps the chip visually compact while its
                          tap target stays 44px. */}
                      {rx.orderId && rx.orderNo && (
                        <Link
                          href={`/orders/${rx.orderId}`}
                          className="press -my-2.5 inline-flex min-h-11 items-center"
                        >
                          <Badge tone="blue">Used on {rx.orderNo}</Badge>
                        </Link>
                      )}
                    </div>

                    {rx.reviewNote && (
                      <p
                        className={cn(
                          "mt-2 rounded-input px-3 py-2 text-xs leading-5",
                          rx.status === "REJECTED"
                            ? "bg-danger/5 text-danger"
                            : "bg-surface-2 text-ink-600",
                        )}
                      >
                        Pharmacist: {rx.reviewNote}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                      <button
                        type="button"
                        onClick={() => viewMut.mutate(rx.id)}
                        disabled={viewMut.isPending && viewMut.variables === rx.id}
                        className="press inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-line text-sm font-semibold text-ink-900 disabled:opacity-60"
                      >
                        {viewMut.isPending && viewMut.variables === rx.id && (
                          <Spinner className="h-4 w-4 text-primary-600" />
                        )}
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(rx)}
                        className="press min-h-11 flex-1 rounded-xl border border-line text-sm font-semibold text-ink-900"
                      >
                        Rename
                      </button>
                      {rx.orderId === null && (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteBlocked(null);
                            setDeleting(rx);
                          }}
                          className="press min-h-11 flex-1 rounded-xl border border-danger/25 text-sm font-semibold text-danger"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </article>
                </Reveal>
              ))}
            </ul>
          )}
        </div>

        {listQuery.hasNextPage && (
          <Button
            variant="secondary"
            className="press w-full"
            loading={listQuery.isFetchingNextPage}
            onClick={() => void listQuery.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </div>

      {/* Sticky upload CTA — clears the 4.5rem tab bar. */}
      <div className="fixed inset-x-0 bottom-16 z-30 mx-auto max-w-md px-4 pb-2">
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="press inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl2 bg-gradient-to-br from-primary-500 to-primary-700 px-4 text-sm font-semibold text-white shadow-glow"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 20h16" />
          </svg>
          Upload prescription
        </button>
      </div>

      <UploadModal
        open={uploadOpen}
        token={token}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setUploadOpen(false);
          void qc.invalidateQueries({ queryKey: ["prescriptions"] });
          toast.push({ type: "success", message: "Prescription added to your locker" });
        }}
      />

      <RenameModal rx={editing} onClose={() => setEditing(null)} />

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete prescription"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {deleteBlocked ? "Close" : "Keep"}
            </Button>
            {!deleteBlocked && (
              <Button
                variant="danger"
                loading={removeMut.isPending}
                onClick={() => deleting && removeMut.mutate(deleting.id)}
              >
                Delete
              </Button>
            )}
          </>
        }
      >
        {deleteBlocked ? (
          <p role="alert" className="text-sm leading-6 text-ink-600">
            {deleteBlocked}
          </p>
        ) : (
          <p className="text-sm leading-6 text-ink-600">
            Delete{" "}
            <span className="font-medium text-ink-900">{deleting?.label || "this prescription"}</span>{" "}
            from your locker? The file is removed permanently and you’ll need to upload it again for
            your next order.
          </p>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------ patient picker */

function usePatients(enabled: boolean) {
  return useQuery({
    queryKey: PATIENTS_KEY,
    queryFn: () => api.get<Patient[]>("/v1/patients"),
    enabled,
    // A locker upload must still work if patient profiles are unavailable.
    retry: false,
  });
}

function PatientField({
  value,
  onChange,
  patients,
}: {
  value: string;
  onChange: (v: string) => void;
  patients: Patient[];
}) {
  return (
    <Field label="Who is it for?" hint="Optional — leave as yourself if it’s your own.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Myself</option>
        {patients.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/* -------------------------------------------------------------- upload modal */

function UploadModal({
  open,
  token,
  onClose,
  onUploaded,
}: {
  open: boolean;
  token: string | null;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [patientId, setPatientId] = useState("");

  const patientsQuery = usePatients(open);
  const patients = patientsQuery.data?.data ?? [];

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setLabel("");
    setDoctorName("");
    setPatientId("");
  }, [open]);

  const upload = useMutation({
    mutationFn: async (): Promise<LockerPrescription> => {
      if (!file) throw new ApiError("INTERNAL", "Choose a file first", 0);
      // Multipart — the JSON api client can't send FormData, so fetch directly.
      const form = new FormData();
      form.append("file", file);
      if (label.trim()) form.append("label", label.trim());
      if (doctorName.trim()) form.append("doctorName", doctorName.trim());
      if (patientId) form.append("patientId", patientId);
      const res = await fetch(`${API_BASE_URL}/v1/prescriptions`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as
        | { data: LockerPrescription; error?: { message: string } }
        | null;
      if (!res.ok || !json) {
        throw new ApiError(
          "INTERNAL",
          json?.error?.message ?? `Upload failed (${res.status})`,
          res.status,
        );
      }
      return json.data;
    },
    onSuccess: onUploaded,
    onError: (err) => toast.push({ type: "error", message: apiErrorMessage(err, "Upload failed") }),
  });

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!picked) return;
    if (picked.size > RX_MAX_UPLOAD_BYTES) {
      toast.push({
        type: "error",
        message: `That file is over ${MAX_UPLOAD_MB} MB — please pick a smaller one`,
      });
      return;
    }
    setFile(picked);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Upload prescription"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="press flex min-h-[104px] w-full flex-col items-center justify-center gap-1 rounded-xl2 border border-dashed border-primary-600/40 bg-primary-50 px-4 py-4 text-center"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6 text-primary-700"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 20h16" />
          </svg>
          <span className="text-sm font-semibold text-primary-800">
            {file ? "Choose a different file" : "Choose a photo or PDF"}
          </span>
          <span className="text-xs text-ink-600">
            Up to {MAX_UPLOAD_MB} MB · JPG, PNG or PDF
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={onPickFile}
        />
        {file && (
          <p className="truncate rounded-input bg-surface-2 px-3 py-2 text-xs text-ink-600" aria-live="polite">
            Selected: <span className="font-medium text-ink-900">{file.name}</span>
          </p>
        )}

        <Field label="Label" hint="Optional — e.g. “Dr Rao — August”.">
          <TextInput
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="Dr Rao — August"
          />
        </Field>
        <Field label="Doctor" hint="Optional">
          <TextInput
            value={doctorName}
            onChange={(e) => setDoctorName(e.target.value)}
            maxLength={80}
            placeholder="Doctor’s name"
          />
        </Field>
        {patients.length > 0 && (
          <PatientField value={patientId} onChange={setPatientId} patients={patients} />
        )}

        <p className="text-xs leading-5 text-ink-400">
          Make sure the doctor’s name, date and signature are readable — a blurred prescription has
          to be rejected by our pharmacist.
        </p>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- rename modal */

function RenameModal({ rx, onClose }: { rx: LockerPrescription | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [patientId, setPatientId] = useState("");

  const patientsQuery = usePatients(rx !== null);
  const patients = patientsQuery.data?.data ?? [];

  useEffect(() => {
    if (!rx) return;
    setLabel(rx.label ?? "");
    setDoctorName(rx.doctorName ?? "");
    setPatientId(rx.patientId ?? "");
  }, [rx]);

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateRxBody = {
        label: label.trim() || undefined,
        doctorName: doctorName.trim() || undefined,
        // null clears the dependent → the prescription belongs to the account holder.
        patientId: patientId || null,
      };
      return api.patch<LockerPrescription>(`/v1/prescriptions/${rx?.id}`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["prescriptions"] });
      toast.push({ type: "success", message: "Prescription updated" });
      onClose();
    },
    onError: (err) => {
      // A reviewed/attached prescription is immutable — say so plainly.
      const message =
        err instanceof ApiError && err.status === 409
          ? "This prescription is attached to an order and can no longer be edited."
          : apiErrorMessage(err, "Could not update this prescription");
      toast.push({ type: "error", message });
    },
  });

  return (
    <Modal
      open={rx !== null}
      onClose={onClose}
      title="Rename prescription"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={label.trim() === ""}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label" error={label.trim() === "" ? "Give it a name you’ll recognise" : undefined}>
          <TextInput
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="Dr Rao — August"
          />
        </Field>
        <Field label="Doctor" hint="Optional">
          <TextInput
            value={doctorName}
            onChange={(e) => setDoctorName(e.target.value)}
            maxLength={80}
            placeholder="Doctor’s name"
          />
        </Field>
        {patients.length > 0 && (
          <PatientField value={patientId} onChange={setPatientId} patients={patients} />
        )}
      </div>
    </Modal>
  );
}
