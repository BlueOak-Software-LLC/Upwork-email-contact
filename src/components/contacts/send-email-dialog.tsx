"use client";

import { useEffect, useState } from "react";
import { useSendEmail } from "@/lib/api/hooks";
import type { Contact } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

const defaultBody = (contact: Contact) =>
  `Hi ${contact.name.split(" ")[0] || contact.name},\n\nI came across${contact.company ? ` ${contact.company}` : " your recent Upwork post"} and thought one of our projects could be a fit.\n\nAre you open to a quick 15-minute call this week?\n\nBest,\nYour name`;

export function SendEmailDialog({
  open,
  recipients,
  onClose,
}: {
  open: boolean;
  recipients: Contact[];
  onClose: () => void;
}) {
  const send = useSendEmail();
  const [subject, setSubject] = useState("Quick question about your project");
  const [body, setBody] = useState("");

  const to = recipients.map((r) => r.email);
  const primary = recipients[0];

  // Prefill the template the first time the composer opens for a selection.
  useEffect(() => {
    if (open && !body) setBody(primary ? defaultBody(primary) : "Hi,\n\n…");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, primary?.id]);

  const submit = async () => {
    if (!to.length) return;
    try {
      await send.mutateAsync({
        // One provider call per recipient keeps addresses private and lets us stamp each contact.
        to,
        subject,
        text: body,
        contactId: recipients.length === 1 ? primary?.id : undefined,
      });
      setBody("");
      onClose();
    } catch {
      // `send.error` renders the message; keep the dialog open so nothing is lost.
    }
  };

  const result = send.data?.data;
  const error = send.error as (Error & { fieldErrors?: Record<string, string> }) | null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send outreach email"
      description={
        recipients.length
          ? `${recipients.length} recipient${recipients.length > 1 ? "s" : ""}: ${to.slice(0, 3).join(", ")}${to.length > 3 ? "…" : ""}`
          : "Select at least one contact first."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={send.isPending}
            disabled={!to.length || !subject.trim() || !body.trim()}
          >
            Send {recipients.length > 1 ? `to ${recipients.length}` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field
          label="Message"
          hint="Plain text — HTML is generated server-side. Sent through POST /api/email/send."
        >
          <Textarea
            rows={9}
            value={body}
            placeholder="Write your message…"
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

        {result ? (
          <p className="text-xs text-brand">
            {result.message} · delivered {result.delivered}/{result.requested}
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-danger">
            {error.message}
            {error.fieldErrors?.text ? ` (${error.fieldErrors.text})` : ""}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
