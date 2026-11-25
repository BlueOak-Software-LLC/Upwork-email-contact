"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, errorMessage } from "@/lib/api/errors";
import { leadKey } from "@/lib/api/outreach-hooks";
import {
  cancelChatGptJob,
  completeChatGptJob,
  createChatGptJob,
  failChatGptJob,
  listChatGptJobs,
  startChatGptJob,
  type ChatGptJobDto,
  type CreateChatGptJobInput,
} from "@/lib/api/chatgpt";
import {
  connectBridge,
  type Bridge,
  type ExtensionMessage,
  type ExtensionPhase,
} from "@/lib/chatgpt/bridge";

export interface SessionJob extends ChatGptJobDto {
  phase?: ExtensionPhase;
  liveText?: string;
}

type Connection = "connecting" | "connected" | "missing" | "disconnected";

interface ChatGptSessionValue {
  jobs: SessionJob[];
  open: boolean;
  setOpen: (open: boolean) => void;
  connection: Connection;
  extensionVersion: string | null;
  chatTabOpen: boolean;
  busyJobId: string | null;
  enqueue: (input: CreateChatGptJobInput) => Promise<ChatGptJobDto | null>;
  submitPastedAnswer: (jobId: string, text: string) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  run: (job: SessionJob) => Promise<boolean>;
  retryConnection: () => void;
  focusChat: () => void;
  dismiss: (jobId: string) => void;
}

const ChatGptSessionContext = createContext<ChatGptSessionValue | null>(null);

const ACTIVE = new Set(["queued", "running", "completing"]);
// Per-tab ownership. A reload may re-send RUN only for a job this tab claimed,
// never for a run that belongs to another browser. The extension also ignores
// a duplicate RUN for the job it is already working on.
const OWNED_KEY = "upwork.chatgpt.owned";

export function ChatGptSessionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const qc = useQueryClient();
  const toast = useToast();
  const leadId = /^\/leads\/([0-9a-f-]{36})/i.exec(pathname ?? "")?.[1] ?? null;

  const [jobs, setJobs] = useState<SessionJob[]>([]);
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [chatTabOpen, setChatTabOpen] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const bridgeRef = useRef<Bridge | null>(null);
  const finalizing = useRef(new Set<string>());
  const ownedRef = useRef<Set<string>>(new Set());
  const jobsRef = useRef<SessionJob[]>([]);
  jobsRef.current = jobs;
  // The drawer only shows the lead in the URL. A late answer for a lead the
  // person already navigated away from is still stored, but must not pop into
  // the current lead's drawer.
  const activeLeadRef = useRef<string | null>(null);
  activeLeadRef.current = leadId;
  const sendRunRef = useRef<(job: SessionJob) => Promise<boolean>>(async () => false);

  const setOwned = useCallback((jobId: string, owned: boolean) => {
    if (owned) ownedRef.current.add(jobId);
    else ownedRef.current.delete(jobId);
    try {
      sessionStorage.setItem(OWNED_KEY, JSON.stringify([...ownedRef.current]));
    } catch {
      // Private mode / storage disabled: ownership still works for this page.
    }
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(OWNED_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored)) {
        ownedRef.current = new Set(stored.filter((id): id is string => typeof id === "string"));
      }
    } catch {
      ownedRef.current = new Set();
    }
  }, []);

  const patchJob = useCallback((id: string, patch: Partial<SessionJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const addJob = useCallback((job: ChatGptJobDto) => {
    setJobs((current) => {
      if (current.some((item) => item.id === job.id)) {
        return current.map((item) => (item.id === job.id ? { ...item, ...job } : item));
      }
      return [job, ...current].slice(0, 40);
    });
  }, []);

  const finalize = useCallback(
    async (jobId: string, text: string) => {
      if (finalizing.current.has(jobId)) return;
      finalizing.current.add(jobId);
      try {
        const result = await completeChatGptJob(jobId, text);
        const job = result.job;
        const visible = job.leadId === activeLeadRef.current;
        if (visible) addJob(job);
        setBusyJobId((current) => (current === jobId ? null : current));
        await qc.invalidateQueries({ queryKey: leadKey(job.leadId) });
        await qc.invalidateQueries({ queryKey: ["leads"] });
        if (visible && job.kind === "ppd_document") {
          toast.success(
            "PPD ready",
            result.documentWords
              ? `${result.documentWords} words${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ""} — review it before drafting the email.`
              : "This PPD was already stored. Review it before drafting the email.",
          );
        } else if (visible && job.kind === "follow_up" && result.draft) {
          toast.success(
            `Follow-up #${result.draft.sequence} drafted`,
            result.warnings.length
              ? `Review it before sending · ${result.warnings.length} warning(s).`
              : "Review and send it when you are ready. The first email is untouched.",
          );
        } else if (visible && result.draft) {
          toast.success(
            "Email draft ready",
            result.warnings.length
              ? `Review the recipient, links and sender before sending · ${result.warnings.length} warning(s).`
              : "Review the recipient, links and sender before sending it.",
          );
        } else if (visible && result.draftError) {
          toast.warn("Answer stored, draft not created", result.draftError);
        } else if (visible) {
          toast.info("Answer already stored", "Refresh the lead to see the saved draft.");
        }
        setOwned(jobId, false);
        bridgeRef.current?.port.postMessage({ type: "ACK", jobId });
      } catch (error) {
        const message = errorMessage(error) ?? "Unknown error";
        const status = error instanceof ApiClientError ? error.status : 0;
        if (status === 409 && /already being stored/i.test(message)) {
          // Another tab won the finalisation claim. Its copy is authoritative;
          // acknowledge our duplicate result so the extension stops replaying it.
          setOwned(jobId, false);
          bridgeRef.current?.port.postMessage({ type: "ACK", jobId });
          patchJob(jobId, { status: "completing" });
          setBusyJobId((current) => (current === jobId ? null : current));
          toast.info("Answer already being stored", "Another tab is saving the same result.");
        } else if (status === 409) {
          // The job was cancelled/failed before this answer arrived. Acknowledge
          // it so the extension does not replay an answer nobody will store.
          setOwned(jobId, false);
          bridgeRef.current?.port.postMessage({ type: "ACK", jobId });
          patchJob(jobId, {
            status: message.includes("cancelled") ? "cancelled" : "failed",
            error: message,
          });
          setBusyJobId((current) => (current === jobId ? null : current));
          toast.warn("ChatGPT job is no longer active", message);
        } else if (status === 400 || status === 422) {
          // The server released the job back to running. Acknowledge the bad
          // answer, keep the job active, and let the person paste a corrected
          // one; do not auto-retype the same prompt.
          setOwned(jobId, false);
          bridgeRef.current?.port.postMessage({ type: "ACK", jobId });
          patchJob(jobId, { status: "running" });
          setBusyJobId((current) => (current === jobId ? null : current));
          toast.error("ChatGPT answer was not usable", `${message} Paste a corrected answer below.`);
        } else {
          patchJob(jobId, { status: "failed", error: message });
          setBusyJobId((current) => (current === jobId ? null : current));
          toast.error("ChatGPT answer could not be stored", message);
        }
      } finally {
        finalizing.current.delete(jobId);
      }
    },
    [addJob, patchJob, qc, setOwned, toast],
  );

  const sendRun = useCallback(async (job: SessionJob) => {
    const bridge = bridgeRef.current;
    if (!bridge) return false;
    try {
      if (job.status === "queued") {
        const started = await startChatGptJob(job.id);
        addJob(started.job);
        if (!started.claimed) {
          // Another dashboard tab/extension won the atomic queued → running
          // claim. Do not send a second prompt for the same job.
          return false;
        }
        setOwned(job.id, true);
      } else if (job.status !== "running" || !ownedRef.current.has(job.id)) {
        // Only the tab that claimed the run may re-send it after a reload.
        // Another browser may still be typing this prompt.
        return false;
      }
      bridge.port.postMessage({
        type: "RUN",
        jobId: job.id,
        prompt: job.prompt,
        system: job.system,
      });
      setBusyJobId(job.id);
      return true;
    } catch (error) {
      toast.error("The ChatGPT tab could not start", errorMessage(error));
      return false;
    }
  }, [addJob, setOwned, toast]);
  sendRunRef.current = sendRun;

  const connect = useCallback(() => {
    if (bridgeRef.current) return;
    setConnection("connecting");
    const bridge = connectBridge();
    if (!bridge) {
      setConnection("missing");
      return;
    }
    bridgeRef.current = bridge;

    bridge.port.onMessage.addListener((message: ExtensionMessage) => {
      if (message.type === "STATUS") {
        setConnection("connected");
        setExtensionVersion(message.version);
        setChatTabOpen(message.chatTabOpen);
        // Queued jobs have no owner yet. A running job is re-sent only by the
        // tab that claimed it, so another browser never types the same prompt.
        for (const job of jobsRef.current) {
          if (job.leadId !== activeLeadRef.current) continue;
          if (job.status === "queued" || (job.status === "running" && ownedRef.current.has(job.id))) {
            void sendRun(job);
          }
        }
        return;
      }
      if (message.type === "RUNNING") {
        const visible = jobsRef.current.some(
          (job) => job.id === message.jobId && job.leadId === activeLeadRef.current,
        );
        patchJob(message.jobId, {
          status: "running",
          phase: message.phase,
          ...(message.chars ? { liveText: `${message.chars} characters read` } : {}),
        });
        if (visible) setBusyJobId(message.jobId);
        return;
      }
      if (message.type === "RESULT") {
        patchJob(message.jobId, { liveText: message.text.slice(0, 400) });
        void finalize(message.jobId, message.text);
        return;
      }
      if (message.type === "PENDING_RESULTS") {
        for (const result of message.results) void finalize(result.jobId, result.text);
        return;
      }
      if (message.type === "ERROR") {
        const failed = jobsRef.current.find((job) => job.id === message.jobId);
        const visible = failed ? failed.leadId === activeLeadRef.current : true;
        setOwned(message.jobId, false);
        patchJob(message.jobId, { status: "failed", error: message.message });
        setBusyJobId((current) => (current === message.jobId ? null : current));
        void failChatGptJob(message.jobId, message.message).catch(() => undefined);
        if (visible) toast.error("ChatGPT could not finish", message.message);
        return;
      }
      if (message.type === "CANCELLED") {
        setOwned(message.jobId, false);
        patchJob(message.jobId, { status: "cancelled" });
        setBusyJobId((current) => (current === message.jobId ? null : current));
      }
    });

    bridge.port.onDisconnect.addListener(() => {
      bridgeRef.current = null;
      setConnection("disconnected");
    });
  }, [finalize, patchJob, sendRun, setOwned, toast]);

  // Connect once, then keep trying while the extension is absent or reloading.
  useEffect(() => {
    connect();
    const timer = setInterval(() => {
      if (!bridgeRef.current && document.visibilityState === "visible") connect();
    }, 8_000);
    const onFocus = () => {
      if (!bridgeRef.current) connect();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      bridgeRef.current?.disconnect();
      bridgeRef.current = null;
    };
  }, [connect]);

  // The drawer follows the lead in the URL; the active run lives in this
  // provider, so navigating away does not abandon it.
  useEffect(() => {
    if (!leadId) {
      setJobs([]);
      return;
    }
    // Do not let the previous lead's running job disable this lead's buttons.
    setJobs((current) => current.filter((job) => job.leadId === leadId));
    const controller = new AbortController();
    const load = () => {
      listChatGptJobs(leadId)
        .then((data) => {
          if (controller.signal.aborted) return;
          setJobs((current) => {
            const scoped = current.filter((job) => job.leadId === leadId);
            const local = new Map(scoped.map((job) => [job.id, job]));
            const fromServer = new Set(data.jobs.map((job) => job.id));
            // Server rows win (a cancelled/failed job must stop looking active),
            // but keep local phase/liveText for the same running job.
            const merged = data.jobs.map((job) => ({ ...local.get(job.id), ...job }));
            // A just-created job can be missing from a fetch that raced it.
            for (const job of scoped) {
              if (ACTIVE.has(job.status) && !fromServer.has(job.id)) merged.push(job);
            }
            return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40);
          });
          // A queued job may have been prepared in another tab or by another
          // user. If the extension is connected, try to claim it; the atomic
          // queued → running update decides which browser gets to run it.
          for (const job of data.jobs) {
            if (!ACTIVE.has(job.status) && ownedRef.current.has(job.id)) setOwned(job.id, false);
            if (
              job.status === "queued" ||
              (job.status === "running" && ownedRef.current.has(job.id))
            ) {
              void sendRunRef.current(job);
            }
          }
        })
        .catch(() => undefined);
    };
    load();
    // Another user can prepare a prompt for this lead while this page is open.
    const timer = setInterval(load, 10_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [leadId, setOwned]);

  const enqueue = useCallback(
    async (input: CreateChatGptJobInput) => {
      setOpen(true);
      try {
        const data = await createChatGptJob(input);
        if (data.reused || !data.job) {
          await qc.invalidateQueries({ queryKey: leadKey(input.leadId) });
          toast.success("Existing PPD reused", "Edit it, or click Regenerate to write a new version.");
          return null;
        }
        addJob(data.job);
        const sent = await sendRun(data.job);
        if (!sent) {
          toast.info(
            "Prompt prepared",
            "Install or open the ChatGPT companion extension, then press Run in this drawer.",
          );
        }
        return data.job;
      } catch (error) {
        toast.error("Could not prepare the ChatGPT prompt", errorMessage(error));
        throw error;
      }
    },
    [addJob, qc, sendRun, toast],
  );

  const submitPastedAnswer = useCallback(
    async (jobId: string, text: string) => {
      if (!text.trim()) return;
      const current = jobsRef.current.find((job) => job.id === jobId);
      if (current?.status === "failed") {
        // The extension gave up, but the person may have the answer in the tab.
        // Reopen the same job instead of forcing a new prompt/row.
        try {
          const started = await startChatGptJob(jobId);
          patchJob(jobId, started.job);
        } catch (error) {
          toast.error("The failed job could not be reopened", errorMessage(error));
          return;
        }
      }
      patchJob(jobId, { status: "running", phase: "copying" });
      await finalize(jobId, text);
    },
    [finalize, patchJob, toast],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      try {
        const data = await cancelChatGptJob(jobId);
        setOwned(jobId, false);
        patchJob(jobId, data.job);
        bridgeRef.current?.port.postMessage({ type: "CANCEL", jobId });
        setBusyJobId((current) => (current === jobId ? null : current));
        toast.info("ChatGPT job cancelled");
      } catch (error) {
        toast.error("The job could not be cancelled", errorMessage(error));
      }
    },
    [patchJob, setOwned, toast],
  );

  const retryConnection = useCallback(() => {
    bridgeRef.current?.disconnect();
    bridgeRef.current = null;
    connect();
  }, [connect]);

  const focusChat = useCallback(() => {
    bridgeRef.current?.port.postMessage({ type: "FOCUS_CHAT" });
  }, []);

  const dismiss = useCallback((jobId: string) => {
    setOwned(jobId, false);
    setJobs((current) => current.filter((job) => job.id !== jobId));
  }, [setOwned]);

  const value = useMemo<ChatGptSessionValue>(
    () => ({
      jobs,
      open,
      setOpen,
      connection,
      extensionVersion,
      chatTabOpen,
      busyJobId,
      enqueue,
      submitPastedAnswer,
      cancel,
      run: sendRun,
      retryConnection,
      focusChat,
      dismiss,
    }),
    [
      jobs,
      open,
      connection,
      extensionVersion,
      chatTabOpen,
      busyJobId,
      enqueue,
      submitPastedAnswer,
      cancel,
      sendRun,
      retryConnection,
      focusChat,
      dismiss,
    ],
  );



  return <ChatGptSessionContext.Provider value={value}>{children}</ChatGptSessionContext.Provider>;
}

export function useChatGptSession() {
  const value = useContext(ChatGptSessionContext);
  if (!value) throw new Error("useChatGptSession must be used inside ChatGptSessionProvider");
  return value;
}
