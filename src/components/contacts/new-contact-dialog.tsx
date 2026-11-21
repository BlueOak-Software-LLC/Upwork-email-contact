"use client";

import { useState } from "react";
import { useCreateContact } from "@/lib/api/hooks";
import { CONTACT_STATUSES } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

export function NewContactDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateContact();
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
    status: "new",
    source: "upwork",
    tags: "",
  });

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    try {
      await create.mutateAsync({
        name: form.name,
        email: form.email,
        company: form.company || null,
        role: form.role || null,
        status: form.status,
        source: form.source || "manual",
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setForm({ name: "", email: "", company: "", role: "", status: "new", source: "upwork", tags: "" });
      onClose();
    } catch {
      // create.error is rendered below; keep the dialog open with the typed values.
    }
  };

  const error = create.error as (Error & { fieldErrors?: Record<string, string> }) | null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New contact"
      description="POST /api/contacts → public.contacts"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={create.isPending}
            disabled={!form.name.trim() || !form.email.includes("@")}
          >
            Save contact
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={error?.fieldErrors?.name}>
          <Input value={form.name} onChange={set("name")} placeholder="Jane Cooper" />
        </Field>
        <Field label="Email" error={error?.fieldErrors?.email}>
          <Input
            type="email"
            value={form.email}
            onChange={set("email")}
            placeholder="jane@company.com"
          />
        </Field>
        <Field label="Company">
          <Input value={form.company} onChange={set("company")} />
        </Field>
        <Field label="Role">
          <Input value={form.role} onChange={set("role")} placeholder="Founder" />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={set("status")}>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source">
          <Input value={form.source} onChange={set("source")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Tags" hint="Comma separated — e.g. saas, us-market">
            <Input value={form.tags} onChange={set("tags")} />
          </Field>
        </div>
      </div>

      {error ? <p className="text-xs text-danger">{error.message}</p> : null}
    </Modal>
  );
}
