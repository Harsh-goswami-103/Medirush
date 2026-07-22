"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePatientBody,
  Patient,
  PatientGender,
  PatientRelation,
  UpdatePatientBody,
} from "@medrush/contracts";
import { api, ApiError, apiErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/toast";
import { NotificationBell } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { Field, Select, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";

const PATIENTS_KEY = ["patients"] as const;

const RELATIONS: readonly { value: PatientRelation; label: string }[] = [
  { value: "SELF", label: "Myself" },
  { value: "SPOUSE", label: "Spouse" },
  { value: "CHILD", label: "Child" },
  { value: "PARENT", label: "Parent" },
  { value: "OTHER", label: "Other" },
];

const GENDERS: readonly { value: PatientGender; label: string }[] = [
  { value: "M", label: "Male" },
  { value: "F", label: "Female" },
  { value: "OTHER", label: "Other" },
];

const relationLabel = (r: PatientRelation) => RELATIONS.find((x) => x.value === r)?.label ?? r;
const genderLabel = (g: PatientGender | null) =>
  g ? (GENDERS.find((x) => x.value === g)?.label ?? g) : null;

/** Whole years from an ISO `YYYY-MM-DD` date of birth. */
function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const born = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (years < 0 || years > 130) return null;
  return years === 0 ? "Under 1 yr" : `${years} yrs`;
}

/* ------------------------------------------------------------------ page */

export default function PatientProfilesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Patient | null>(null);
  const [deleting, setDeleting] = useState<Patient | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  const patientsQuery = useQuery({
    queryKey: PATIENTS_KEY,
    queryFn: () => api.get<Patient[]>("/v1/patients"),
    enabled: Boolean(user),
  });

  const removePatient = useMutation({
    mutationFn: (id: string) => api.del(`/v1/patients/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PATIENTS_KEY });
      setDeleting(null);
      toast.push({ type: "success", message: "Profile removed" });
    },
    onError: (err) => {
      // 409 = a past order was placed for this person; the record must survive.
      if (err instanceof ApiError && err.status === 409) {
        setDeleteBlocked(
          "This profile is on one or more past orders, so we have to keep it — a pharmacy record must always show who each medicine was dispensed for. You can rename it instead.",
        );
        return;
      }
      setDeleteBlocked(apiErrorMessage(err, "Could not remove this profile."));
    },
  });

  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const patients = patientsQuery.data?.data ?? [];

  return (
    <div className="min-h-dvh bg-mesh pb-10">
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
        <h1 className="flex-1 truncate text-base font-semibold text-ink-900">Patient profiles</h1>
        <NotificationBell />
      </header>

      <div className="space-y-4 p-4">
        <p className="px-1 text-sm leading-6 text-ink-600">
          Add the people you order for. Choosing a patient at checkout keeps the prescription
          register accurate and helps our pharmacist check the dose is right for their age.
        </p>

        <div aria-live="polite">
          {patientsQuery.isError ? (
            <ErrorState
              message={(patientsQuery.error as Error).message}
              onRetry={() => patientsQuery.refetch()}
            />
          ) : patientsQuery.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-xl2 bg-surface p-4 shadow-card2">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-11 w-11 rounded-full" />
                    <span className="flex-1">
                      <Skeleton className="h-4 w-28 rounded" />
                      <Skeleton className="mt-2 h-3 w-40 rounded" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : patients.length === 0 ? (
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
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                  <path d="M9 11a4 4 0 100-8 4 4 0 000 8z" />
                  <path d="M22 21v-2a4 4 0 00-3-3.87" />
                  <path d="M16 3.13a4 4 0 010 7.75" />
                </svg>
              }
              title="No patient profiles yet"
              hint="Add a family member so you can order on their behalf."
              action={
                <Button
                  className="w-full"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  Add a profile
                </Button>
              }
            />
          ) : (
            <ul className="space-y-3">
              {patients.map((p, i) => {
                const age = ageFromDob(p.dob);
                const gender = genderLabel(p.gender);
                return (
                  <Reveal as="li" key={p.id} delayMs={Math.min(i, 5) * 40}>
                    <div className="rounded-xl2 bg-surface p-4 shadow-card2">
                      <div className="flex items-start gap-3">
                        <span
                          aria-hidden
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-100 to-primary-200 text-base font-bold text-primary-800"
                        >
                          {p.name.trim().charAt(0).toUpperCase() || "?"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-900">
                            <span className="truncate">{p.name}</span>
                            <Badge tone="teal">{relationLabel(p.relation)}</Badge>
                          </p>
                          <p className="mt-0.5 text-xs text-ink-600">
                            {[age, gender].filter(Boolean).join(" · ") || "No age or gender saved"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex gap-2 border-t border-line pt-3">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(p);
                            setFormOpen(true);
                          }}
                          className="press min-h-11 flex-1 rounded-xl border border-line text-sm font-semibold text-ink-900"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteBlocked(null);
                            setDeleting(p);
                          }}
                          className="press min-h-11 flex-1 rounded-xl border border-danger/25 text-sm font-semibold text-danger"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </ul>
          )}
        </div>

        {patients.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            className="press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl2 bg-gradient-to-br from-primary-500 to-primary-700 px-4 text-sm font-semibold text-white shadow-glow"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add a profile
          </button>
        )}
      </div>

      <PatientFormModal open={formOpen} initial={editing} onClose={() => setFormOpen(false)} />

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Remove profile"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {deleteBlocked ? "Close" : "Keep"}
            </Button>
            {!deleteBlocked && (
              <Button
                variant="danger"
                loading={removePatient.isPending}
                onClick={() => deleting && removePatient.mutate(deleting.id)}
              >
                Remove
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
            Remove <span className="font-medium text-ink-900">{deleting?.name}</span> from your
            profiles? Past orders placed for them are unaffected.
          </p>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------- add/edit modal */

function PatientFormModal({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Patient | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState("");
  const [relation, setRelation] = useState<PatientRelation>("CHILD");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<PatientGender | "">("");

  useEffect(() => {
    setName(initial?.name ?? "");
    setRelation(initial?.relation ?? "CHILD");
    setDob(initial?.dob ?? "");
    setGender(initial?.gender ?? "");
  }, [initial, open]);

  const save = useMutation({
    mutationFn: () => {
      const body: CreatePatientBody | UpdatePatientBody = {
        name: name.trim(),
        relation,
        dob: dob || undefined,
        gender: gender || undefined,
      };
      return initial
        ? api.patch<Patient>(`/v1/patients/${initial.id}`, body)
        : api.post<Patient>("/v1/patients", body as CreatePatientBody);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PATIENTS_KEY });
      toast.push({ type: "success", message: initial ? "Profile updated" : "Profile added" });
      onClose();
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save this profile") }),
  });

  const today = new Date().toISOString().slice(0, 10);
  const nameOk = name.trim().length > 0 && name.trim().length <= 80;
  const dobOk = dob === "" || dob <= today;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? "Edit profile" : "Add profile"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!nameOk || !dobOk}
            loading={save.isPending}
          >
            {initial ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Full name"
          error={name !== "" && !nameOk ? "Enter a name of up to 80 characters" : undefined}
        >
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Anita Sharma"
          />
        </Field>
        <Field label="Relationship">
          <Select
            value={relation}
            onChange={(e) => setRelation(e.target.value as PatientRelation)}
          >
            {RELATIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Date of birth"
            hint="Optional"
            error={!dobOk ? "Date can’t be in the future" : undefined}
          >
            <TextInput
              type="date"
              value={dob}
              max={today}
              onChange={(e) => setDob(e.target.value)}
            />
          </Field>
          <Field label="Gender" hint="Optional">
            <Select
              value={gender}
              onChange={(e) => setGender(e.target.value as PatientGender | "")}
            >
              <option value="">Not specified</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className={cn("text-xs leading-5 text-ink-400")}>
          Age helps our pharmacist confirm the dose is appropriate. We never share these details
          outside the dispensing record.
        </p>
      </div>
    </Modal>
  );
}
