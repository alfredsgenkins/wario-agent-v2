import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./types.js";

const STORE_PATH = path.resolve(
  import.meta.dirname,
  "../.wario-sessions.json"
);

type Store = Record<string, SessionRecord>;

function read(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function write(store: Store): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n");
}

export function getSession(issueKey: string): SessionRecord | null {
  return read()[issueKey] ?? null;
}

export function setSession(record: SessionRecord): void {
  const store = read();
  store[record.issueKey] = record;
  write(store);
}

export function updateStatus(
  issueKey: string,
  status: SessionRecord["status"]
): void {
  const store = read();
  if (store[issueKey]) {
    store[issueKey].status = status;
    store[issueKey].lastEventAt = new Date().toISOString();
    write(store);
  }
}

export function getAllSessions(): Store {
  return read();
}
