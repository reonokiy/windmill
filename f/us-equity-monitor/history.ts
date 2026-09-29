import { getState, setState } from "windmill-client";

export type SentMessage = { sentAt: string; messageId: number; opinion: string; text: string };
export type MessageHistory = { version: 1; messages: SentMessage[] };
export interface HistoryStore {
  load(): Promise<unknown>;
  save(history: MessageHistory): Promise<void>;
}

/** Explicit destination scope is shared by scheduled, manual and local runs. */
export function createHistoryStore(chatId: string, threadId?: number): HistoryStore {
  const path = `f/us-equity-monitor/notification_state_${Buffer.from(chatId).toString("hex")}_${threadId ?? 0}`;
  return { load: () => getState(path), save: history => setState(history, path) };
}

export function recentHistory(value: unknown, now = Date.now()): MessageHistory {
  if (value == null) return { version: 1, messages: [] };
  const state = value as MessageHistory;
  if (state.version !== 1 || !Array.isArray(state.messages) || state.messages.some(item =>
    !item || !Number.isFinite(Date.parse(item.sentAt)) || !Number.isSafeInteger(item.messageId) ||
    typeof item.opinion !== "string" || typeof item.text !== "string")) {
    throw new Error("Invalid notification history; no message sent");
  }
  return { version: 1, messages: state.messages.filter(item => {
    const time = Date.parse(item.sentAt);
    return time > now - 24 * 60 * 60 * 1000 && time <= now;
  }).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt)) };
}
