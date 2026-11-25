"use client";

/**
 * The app side of the companion Chrome extension.
 *
 * The server can never read the user's ChatGPT cookies, so the browser is the
 * bridge: the dashboard connects to the extension's background worker, hands it
 * a prepared prompt, and receives the answer it copied from the ChatGPT tab.
 * Nothing here talks to an OpenAI API.
 */

export const DEFAULT_EXTENSION_ID = "phieeciapeplplficoclmjenfbmbdcke";

export function extensionId(): string {
  return process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID?.trim() || DEFAULT_EXTENSION_ID;
}

export type ExtensionPhase = "opening" | "typing" | "waiting" | "copying" | "done";

export type ExtensionMessage =
  | { type: "STATUS"; connected: true; version: string; chatTabOpen: boolean }
  | { type: "RUNNING"; jobId: string; phase: ExtensionPhase; chars?: number }
  | { type: "RESULT"; jobId: string; text: string }
  | { type: "ERROR"; jobId: string; message: string }
  | { type: "PENDING_RESULTS"; results: Array<{ jobId: string; text: string }> }
  | { type: "CANCELLED"; jobId: string };

export type AppMessage =
  | { type: "RUN"; jobId: string; prompt: string; system?: string }
  | { type: "CANCEL"; jobId: string }
  | { type: "ACK"; jobId: string }
  | { type: "FOCUS_CHAT" };

interface PortLike {
  postMessage: (message: AppMessage) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: ExtensionMessage) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

interface RuntimeLike {
  connect: (id: string, info?: { name?: string }) => PortLike;
  lastError?: { message?: string };
}

type ChromeLike = { runtime?: RuntimeLike };

export interface Bridge {
  port: PortLike;
  disconnect: () => void;
}

export function connectBridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  const runtime = (window as unknown as { chrome?: ChromeLike }).chrome?.runtime;
  if (!runtime?.connect) return null;
  try {
    const port = runtime.connect(extensionId(), { name: "upwork-email-contact" });
    return { port, disconnect: () => port.disconnect() };
  } catch {
    return null;
  }
}