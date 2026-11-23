"use client";

import { useState } from "react";
import {
  useCreateSenderAccount,
  useDeleteSenderAccount,
  useSenderAccounts,
  useTestSenderAccount,
} from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/skeleton";

const GMAIL = { host: "smtp.gmail.com", port: 465, secure: true };

const PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  custom: { host: "", port: 587, secure: false },
  gmail: GMAIL,
  zoho: { host: "smtp.zoho.com", port: 465, secure: true },
  mailgun: { host: "smtp.mailgun.org", port: 587, secure: false },
  resend_smtp: { host: "smtp.resend.com", port: 465, secure: true },
  ses: { host: "email-smtp.eu-west-1.amazonaws.com", port: 465, secure: true },
};

const emptyForm = {
  label: "",
  fromEmail: "",
  displayName: "",
  smtpUser: "",
  smtpPassword: "",
  smtpHost: GMAIL.host,
  smtpPort: String(GMAIL.port),
  smtpSecure: "true",
  dailyLimit: "50",
  isDefault: true,
};

export function SendersView() {
  const accounts = useSenderAccounts();
  const create = useCreateSenderAccount();
  const test = useTestSenderAccount();
  const remove = useDeleteSenderAccount();

  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("gmail");
  const [form, setForm] = useState(emptyForm);

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const applyPreset = (name: string) => {
    const p = PRESETS[name] ?? { host: "", port: 587, secure: false };
    setPreset(name);
    setForm((f) => ({
      ...f,
      smtpHost: p.host,
      smtpPort: String(p.port),
      smtpSecure: String(p.secure),
    }));
  };

  const submit = async () => {
    try {
      await create.mutateAsync({
        label: form.label,
        fromEmail: form.fromEmail,
        displayName: form.displayName || null,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort),
        smtpSecure: form.smtpSecure === "true",
        smtpUser: form.smtpUser || form.fromEmail,
        smtpPassword: form.smtpPassword,
        dailyLimit: Number(form.dailyLimit) || 50,
        isDefault: form.isDefault,
      });
      setOpen(false);
      setForm({ ...emptyForm });
    } catch {
      /* create.error is shown below */
    }
  };

  const error = create.error as Error | null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted/80">
          Our sending mailboxes. The password is encrypted with{" "}
          <code>APP_ENCRYPTION_KEY</code> (AES-256-GCM) before it reaches Postgres and is
          never returned by the API.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          Add sender account
        </Button>
      </div>

      <div className="card overflow-hidden">
        {accounts.isLoading ? (
          <TableSkeleton rows={2} />
        ) : (accounts.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">
            No sender accounts yet — add the first of your two mailboxes.
          </p>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Label</Th>
                <Th>From</Th>
                <Th>SMTP</Th>
                <Th>Password</Th>
                <Th>Limit</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </THead>
            <TBody>
              {(accounts.data ?? []).map((account) => (
                <Tr key={account.id}>
                  <Td>
                    <div className="font-medium">{account.label}</div>
                    {account.is_default ? (
                      <div className="text-[11px] text-brand">default</div>
                    ) : null}
                  </Td>
                  <Td className="text-muted">
                    {account.from_email}
                    {account.display_name ? (
                      <div className="text-[11px] text-muted/70">{account.display_name}</div>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-muted">
                    {account.smtp_host}:{account.smtp_port}
                    <span className="ml-1 text-muted/60">
                      ({account.smtp_secure ? "TLS 465" : "STARTTLS"})
                    </span>
                  </Td>
                  <Td className="text-xs text-muted">
                    {account.has_password ? account.password_mask : "not set"}
                  </Td>
                  <Td className="tabular text-xs text-muted">
                    {account.sent_count}/{account.daily_limit}/day
                  </Td>
                  <Td>
                    <StatusBadge status={account.status} />
                    {account.last_error ? (
                      <div className="mt-1 max-w-[16rem] truncate text-[11px] text-danger">
                        {account.last_error}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={test.isPending && test.variables === account.id}
                      onClick={() => test.mutate(account.id, { onError: () => undefined })}
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      loading={remove.isPending && remove.variables === account.id}
                      onClick={() => {
                        if (confirm(`Remove ${account.from_email}?`))
                          remove.mutate(account.id, { onError: () => undefined });
                      }}
                    >
                      Remove
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {test.data ? (
        <p className={test.data.data.ok ? "text-xs text-brand" : "text-xs text-danger"}>
          {test.data.data.ok
            ? `${test.data.data.account}: SMTP login OK`
            : `${test.data.data.account}: ${test.data.data.error}`}
        </p>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add sender account"
        description="POST /api/sender-accounts — stored encrypted, used by POST /api/drafts/:id/send"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={
                !form.label.trim() ||
                !form.fromEmail.includes("@") ||
                !form.smtpHost.trim() ||
                form.smtpPassword.length < 6
              }
            >
              Save account
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label">
            <Input value={form.label} onChange={set("label")} placeholder="Studio Gmail" />
          </Field>
          <Field label="From address">
            <Input
              type="email"
              value={form.fromEmail}
              onChange={set("fromEmail")}
              placeholder="hello@yourdomain.com"
            />
          </Field>
          <Field label="Display name">
            <Input value={form.displayName} onChange={set("displayName")} />
          </Field>
          <Field label="SMTP login" hint="defaults to the from address">
            <Input value={form.smtpUser} onChange={set("smtpUser")} />
          </Field>
          <Field label="Preset">
            <Select value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {Object.keys(PRESETS).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SMTP host">
            <Input value={form.smtpHost} onChange={set("smtpHost")} />
          </Field>
          <Field label="Port">
            <Input value={form.smtpPort} onChange={set("smtpPort")} inputMode="numeric" />
          </Field>
          <Field label="Implicit TLS (465)">
            <Select value={form.smtpSecure} onChange={set("smtpSecure")}>
              <option value="true">yes — secure</option>
              <option value="false">no — STARTTLS</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Password / app password" hint="never displayed again after saving">
              <Input
                type="password"
                autoComplete="new-password"
                value={form.smtpPassword}
                onChange={set("smtpPassword")}
              />
            </Field>
          </div>
          <Field label="Daily limit">
            <Input value={form.dailyLimit} onChange={set("dailyLimit")} inputMode="numeric" />
          </Field>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
            />
            Use as default sender
          </label>
        </div>

        {error ? <p className="text-xs text-danger">{error.message}</p> : null}
      </Modal>
    </div>
  );
}
