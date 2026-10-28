/**
 * Persistence for FCM credentials + seen persistent-ids, so we register the FCM
 * token ONCE and just reconnect (and don't re-receive old pushes) across runs.
 */
import { FileSessionStore } from "../../core/store.js";
import type { FcmCredentials } from "./types.js";

export interface PersistedPush {
  creds: FcmCredentials;
  persistentIds: string[];
}

export interface FcmStore {
  load(): PersistedPush | null;
  save(p: PersistedPush): void;
  clear(): void;
}

export class MemoryFcmStore implements FcmStore {
  private p: PersistedPush | null = null;
  load(): PersistedPush | null {
    return this.p;
  }
  save(p: PersistedPush): void {
    this.p = p;
  }
  clear(): void {
    this.p = null;
  }
}

/** JSON-file FCM store: the {@link FileSessionStore} file format and write guarantees, on the push record. */
export class FileFcmStore extends FileSessionStore<PersistedPush> implements FcmStore {}
