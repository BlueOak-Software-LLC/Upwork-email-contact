"use client";

import { useState } from "react";
import {
  useCreateSenderAccount,
  useDeleteSenderAccount,
  useSenderAccounts,
  useTestSenderAccount,
  useUpdateSenderAccount,
} from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/skeleton";
import type { SenderAccountDto } from "@/server/db/sender-accounts.repo";
import { emailSignatureLines } from "@/lib/email-signature";

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
  companyName: "",
  roleTitle: "",
  replyTo: "",
  phone: "",
  whatsapp: "",
  linkedinUrl: "",
  website: "",
  location: "",
  experienceSummary: "",
  skills: "",
  smtpUser: "",
  smtpPassword: "",
  smtpHost: GMAIL.host,
  smtpPort: String(GMAIL.port),
  smtpSecure: "true",
  dailyLimit: "50",
  isDefault: true,
};

function formFromAccount(account: SenderAccountDto) {
  return {
    label: account.label,
    fromEmail: account.from_email,
    displayName: account.display_name ?? "",
    companyName: account.company_name ?? "",
    roleTitle: account.role_title ?? "",
    replyTo: account.reply_to ?? "",
    phone: account.phone ?? "",
    whatsapp: account.whatsapp ?? "",
    linkedinUrl: account.linkedin_url ?? "",
    website: account.website ?? "",
    location: account.location ?? "",
    experienceSummary: account.experience_summary ?? "",
    skills: account.skills ?? "",
    smtpUser: account.smtp_user ?? "",
    smtpPassword: "",
    smtpHost: account.smtp_host,
    smtpPort: String(account.smtp_port),
    smtpSecure: String(account.smtp_secure),
    dailyLimit: String(account.daily_limit),
    isDefault: account.is_default,
  };
}

export function SendersView() {
  const accounts = useSenderAccounts();
  const create = useCreateSenderAccount();
  const update = useUpdateSenderAccount();
  const test = useTestSenderAccount();
  const remove = useDeleteSenderAccount();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preset, setPreset] = useState("gmail");
  const [form, setForm] = useState(emptyForm);
  const signaturePreview = emailSignatureLines({
    name: form.displayName,
    role: form.roleTitle,
    company: form.companyName,
    website: form.website,
  }).join("\n");

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = () => {
    setEditingId(null);
    setPreset("gmail");
    setForm({ ...emptyForm });
    setOpen(true);
  };

  const openEdit = (account: SenderAccountDto) => {
    setEditingId(account.id);
    setPreset("custom");
    setForm(formFromAccount(account));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setEditingId(null);
  };

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
    const body = {
      label: form.label,
      fromEmail: form.fromEmail,
      displayName: form.displayName || null,
      companyName: form.companyName || null,
      replyTo: form.replyTo || null,
      roleTitle: form.roleTitle || null,
      phone: form.phone || null,
      whatsapp: form.whatsapp || null,
      linkedinUrl: form.linkedinUrl || null,
      website: form.website || null,
      location: form.location || null,
      experienceSummary: form.experienceSummary || null,
      skills: form.skills || null,
      smtpHost: form.smtpHost,
      smtpPort: Number(form.smtpPort),
      smtpSecure: form.smtpSecure === "true",
      smtpUser: form.smtpUser || form.fromEmail,
      dailyLimit: Number(form.dailyLimit) || 50,
      isDefault: form.isDefault,
    };
    try {
      if (editingId) {
        await update.mutateAsync({
          id: editingId,
          ...body,
          ...(form.smtpPassword ? { smtpPassword: form.smtpPassword } : {}),
        });
      } else {
        await create.mutateAsync({ ...body, smtpPassword: form.smtpPassword });
      }
      close();
      setForm({ ...emptyForm });
    } catch {
      /* mutation error is shown below */
    }
  };

  const error = (editingId ? update.error : create.error) as Error | null;
  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted/80">
          Sending mailboxes and the person printed on proposals. The selected profile supplies
          the PPD name, role and contact block, and the email sign-off. The SMTP password is
          encrypted with <code>APP_ENCRYPTION_KEY</code> (AES-256-GCM) before it reaches
          Postgres and is never returned by the API.
        </p>
        <Button size="sm" onClick={openCreate}>
          Add sender profile
        </Button>
      </div>

      <div className="card overflow-hidden">
        {accounts.isLoading ? (
          <TableSkeleton rows={2} />
        ) : (accounts.data ?? []).length === 0 ? (
          <EmptyState
            title="No sender profiles yet"
            description={
              <>
                Add the mailbox you want to send from and the profile details you want printed
                on proposals. The SMTP password is encrypted with
                <code> APP_ENCRYPTION_KEY</code> before it reaches Postgres.
              </>
            }
            action={
              <Button size="sm" onClick={openCreate}>
                Add sender profile
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Profile</Th>
                <Th>From</Th>
                <Th>SMTP</Th>
                <Th>Password</Th>
                <Th>Limit</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </THead>
            <TBody>
              {(accounts.data ?? []).map((account) => {
                const contacts = [
                  account.phone,
                  account.linkedin_url,
                  account.website,
                ].filter(Boolean).length;
                return (
                  <Tr key={account.id}>
                    <Td>
                      <div className="font-medium">{account.display_name || account.label}</div>
                      {account.role_title ? (
                        <div className="text-[11px] text-muted/70">{account.role_title}</div>
                      ) : null}
                      <div className="mt-0.5 text-[11px] text-muted/60">
                        {account.label}
                        {account.is_default ? " · default" : ""}
                        {contacts ? ` · ${contacts} contact detail${contacts === 1 ? "" : "s"}` : ""}
                      </div>
                    </Td>
                    <Td className="text-muted">{account.from_email}</Td>
                    <Td className="text-xs text-muted">
                      {account.smtp_host}:{account.smtp_port}
                      <span className="ml-1 text-muted/60">
                        ({account.smtp_secure ? "TLS 465" : "STARTTLS"})
                      </span>
                    </Td>
                    <Td className="text-xs text-muted">
                      {account.has_password ? (
                        <span className="tabular">{account.password_mask}</span>
                      ) : (
                        <span className="rounded bg-warn/12 px-1.5 py-0.5 text-warn">
                          password not stored — sending with this account will fail
                        </span>
                      )}
                    </Td>
                    <Td className="tabular text-xs text-muted">
                      {account.sent_count}/{account.daily_limit}/day
                    </Td>
                    <Td>
                      <StatusBadge status={account.status} />
                      <div className="mt-1 text-[11px] text-muted/70">
                        {account.last_verified_at ? (
                          <>
                            verified <TimeAgo value={account.last_verified_at} />
                          </>
                        ) : (
                          "never verified"
                        )}
                      </div>
                      {account.last_error ? (
                        <div className="mt-1 max-w-[16rem] truncate text-[11px] text-danger">
                          {account.last_error}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(account)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={test.isPending && test.variables === account.id}
                        onClick={() => test.mutate(account.id, { onError: () => undefined })}
                      >
                        Test login
                      </Button>
                      <ConfirmAction
                        label="Remove"
                        title={`Remove ${account.from_email}?`}
                        description="Drafts that chose this sender fall back to the SMTP settings from the environment."
                        busy={remove.isPending && remove.variables === account.id}
                        onConfirm={() => remove.mutate(account.id)}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      {test.data ? (
        <p
          className={test.data.data.ok ? "text-xs text-brand" : "text-xs text-danger"}
          role="status"
        >
          {test.data.data.ok
            ? `${test.data.data.account}: SMTP login OK`
            : `${test.data.data.account}: ${test.data.data.error}`}
        </p>
      ) : null}

      <Modal
        open={open}
        onClose={close}
        title={editingId ? "Edit sender profile" : "Add sender profile"}
        description="Manage the sender identity, signature, and SMTP mailbox in one place."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={busy}
              disabled={
                !form.label.trim() ||
                !form.fromEmail.includes("@") ||
                !form.displayName.trim() ||
                !form.smtpHost.trim() ||
                (!editingId && form.smtpPassword.length < 6)
              }
            >
              {editingId ? "Save changes" : "Save profile"}
            </Button>
          </>
        }
        className="max-w-4xl"
      >
        <div className="space-y-5">
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <h3 className="text-sm font-semibold">Person on the proposal</h3>
              <p className="text-xs text-muted">
                The PPD uses the profile details; email uses a fixed, privacy-safe signature with
                your name, role, WhatsApp link, and linked company website.
              </p>
            </div>
            <Field label="Profile label" hint="internal name, not printed">
              <Input value={form.label} onChange={set("label")} placeholder="Luan — Gmail" />
            </Field>
            <Field label="Full name">
              <Input
                value={form.displayName}
                onChange={set("displayName")}
                placeholder="Luan Le"
              />
            </Field>
            <Field label="Role / title">
              <Input
                value={form.roleTitle}
                onChange={set("roleTitle")}
                placeholder="Senior Software Engineer"
              />
            </Field>
            <Field label="Company name" hint="shown as the website link label">
              <Input
                value={form.companyName}
                onChange={set("companyName")}
                placeholder="Your company"
              />
            </Field>
            <Field label="Location" hint="city / timezone">
              <Input
                value={form.location}
                onChange={set("location")}
                placeholder="Ho Chi Minh City, GMT+7"
              />
            </Field>
            <div className="sm:col-span-2">
              <div className="rounded-xl border border-line bg-surface-2/60 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Email signature preview</h4>
                  <span className="text-[11px] text-muted/70">Generated from this profile</span>
                </div>
                <div className="whitespace-pre-wrap text-sm leading-6 text-ink">{signaturePreview.split("\n").map((line, index) => {
                  const match = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
                  return (
                    <div key={`${index}-${line}`}>
                      {match ? (
                        <>{line.slice(0, match.index)}<a className="text-brand underline underline-offset-2" href={match[2]} target="_blank" rel="noreferrer">{match[1]}</a></>
                      ) : line}
                    </div>
                  );
                })}</div>
              </div>
            </div>
            <Field label="Phone" hint="proposal document only; never shown in email signature">
              <Input value={form.phone} onChange={set("phone")} placeholder="+84 ..." />
            </Field>
            <Field label="WhatsApp" hint="Email uses the configured company start-chat link">
              <Input
                value={form.whatsapp}
                onChange={set("whatsapp")}
                placeholder="https://wa.me/84..."
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Website / portfolio" hint="linked under the company name in the email signature">
                <Input
                  value={form.website}
                  onChange={set("website")}
                  placeholder="yourdomain.com"
                />
              </Field>
            </div>
            <Field label="LinkedIn">
              <Input
                value={form.linkedinUrl}
                onChange={set("linkedinUrl")}
                placeholder="linkedin.com/in/your-name"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Experience summary"
                hint="real projects, stack and outcomes; the email may use only this"
              >
                <Textarea
                  value={form.experienceSummary}
                  onChange={set("experienceSummary")}
                  rows={5}
                  placeholder="10 years building React/Node products. Shipped a booking platform used by 40k monthly users; led migration from Rails to Next.js..."
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Skills" hint="comma or newline separated">
                <Input
                  value={form.skills}
                  onChange={set("skills")}
                  placeholder="React, TypeScript, Next.js, Supabase, Node.js"
                />
              </Field>
            </div>
          </section>

          <section className="grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <h3 className="text-sm font-semibold">Sending mailbox</h3>
              <p className="text-xs text-muted">
                Used by SMTP. The from address is also printed as the email contact on the PPD.
              </p>
            </div>
            <Field label="From address">
              <Input
                type="email"
                value={form.fromEmail}
                onChange={set("fromEmail")}
                placeholder="hello@yourdomain.com"
              />
            </Field>
            <Field label="Reply-to" hint="optional">
              <Input
                type="email"
                value={form.replyTo}
                onChange={set("replyTo")}
                placeholder="you@yourdomain.com"
              />
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
              <Field
                label="Password / app password"
                hint={editingId ? "leave blank to keep the stored password" : "never displayed again after saving"}
              >
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
              Use as default profile
            </label>
          </section>
        </div>

        {error ? <p className="text-xs text-danger">{error.message}</p> : null}
      </Modal>
    </div>
  );
}
