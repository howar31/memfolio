// Folder handles live in IndexedDB of the page origin the content script runs
// in: a handle can only be used from the origin that obtained it.

const DB_NAME = 'memfolio';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const get = <T>(key: string): Promise<T | undefined> => tx<T | undefined>('readonly', (s) => s.get(key));
const set = (key: string, value: unknown): Promise<unknown> => tx('readwrite', (s) => s.put(value, key));
const del = (key: string): Promise<unknown> => tx('readwrite', (s) => s.delete(key));
const keys = (): Promise<IDBValidKey[]> => tx('readonly', (s) => s.getAllKeys());

function isDir(v: unknown): v is FileSystemDirectoryHandle {
  return typeof FileSystemDirectoryHandle !== 'undefined' && v instanceof FileSystemDirectoryHandle;
}

/** Folder handles of one platform: the default location, known parents, and one folder per account id. */
export class HandleStore {
  constructor(private platform: string) {}

  private accountKey(id: string): string {
    return `dir:${this.platform}:${id}`;
  }

  /** The folder new accounts get their own folder in. `root:` is the key it was stored under before. */
  async getDefault(): Promise<FileSystemDirectoryHandle | null> {
    const v = (await get<unknown>(`default:${this.platform}`)) ?? (await get<unknown>(`root:${this.platform}`));
    return isDir(v) ? v : null;
  }

  async setDefault(handle: FileSystemDirectoryHandle): Promise<void> {
    await set(`default:${this.platform}`, handle);
  }

  /** Folders picked as import parents; used to show an account folder's relative path. */
  async getParents(): Promise<FileSystemDirectoryHandle[]> {
    const v = await get<unknown>(`parents:${this.platform}`);
    return Array.isArray(v) ? v.filter(isDir) : [];
  }

  async addParent(handle: FileSystemDirectoryHandle): Promise<void> {
    const parents = await this.getParents();
    for (const p of parents) if (await p.isSameEntry(handle)) return;
    parents.push(handle);
    await set(`parents:${this.platform}`, parents);
  }

  async getAccount(id: string): Promise<FileSystemDirectoryHandle | null> {
    const v = await get<unknown>(this.accountKey(id));
    return isDir(v) ? v : null;
  }

  async setAccount(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
    await set(this.accountKey(id), handle);
  }

  async deleteAccount(id: string): Promise<void> {
    await del(this.accountKey(id));
  }

  async accountIds(): Promise<string[]> {
    const prefix = `dir:${this.platform}:`;
    return (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
}
