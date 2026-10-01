// In-memory stand-in for the File System Access handles used by the core
// modules. Real handles are exercised by the end-to-end suite (OPFS).

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

export class FakeFile {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(
    public name: string,
    private parent: FakeDir,
  ) {}

  async getFile(): Promise<{ size: number; name: string; arrayBuffer(): Promise<ArrayBuffer> }> {
    this.parent.assertAlive();
    const bytes = this.bytes;
    return { size: bytes.byteLength, name: this.name, arrayBuffer: async () => bytes.slice().buffer };
  }

  async createWritable(): Promise<WritableStream<Uint8Array> & { abort(reason?: unknown): Promise<void> }> {
    this.parent.assertAlive();
    const chunks: Uint8Array[] = [];
    const commit = (): void => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      this.bytes = out;
    };
    // Like Chromium's swap file: data reaches the file only on close.
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.parent.failWrites) throw domError('NoModificationAllowedError');
        chunks.push(chunk);
      },
      close: commit,
    }) as WritableStream<Uint8Array> & { abort(reason?: unknown): Promise<void> };
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}

export class FakeDir {
  kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  /** Names that behave like filesystem links: present on disk, invisible and unreachable. */
  links = new Set<string>();
  permission: PermissionState = 'granted';
  removed = false;
  failWrites = false;
  parent: FakeDir | null = null;

  constructor(public name: string) {}

  assertAlive(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let d: FakeDir | null = this;
    while (d) {
      if (d.removed) throw domError('NotFoundError');
      d = d.parent;
    }
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    if (this.permission === 'prompt') this.permission = 'granted';
    return this.permission;
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    this.assertAlive();
    if (this.links.has(name)) throw domError('NotFoundError');
    const existing = this.children.get(name);
    if (existing instanceof FakeDir) return existing;
    if (existing) throw domError('TypeMismatchError');
    if (!opts.create) throw domError('NotFoundError');
    return this.mkdir(name);
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFile> {
    this.assertAlive();
    const existing = this.children.get(name);
    if (existing instanceof FakeFile) return existing;
    if (existing) throw domError('TypeMismatchError');
    if (!opts.create) throw domError('NotFoundError');
    const f = new FakeFile(name, this);
    this.children.set(name, f);
    return f;
  }

  async removeEntry(name: string): Promise<void> {
    this.assertAlive();
    if (!this.children.delete(name)) throw domError('NotFoundError');
  }

  async *entries(): AsyncGenerator<[string, FakeDir | FakeFile]> {
    this.assertAlive();
    for (const e of [...this.children.entries()]) yield e;
  }

  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) yield name;
  }

  async *values(): AsyncGenerator<FakeDir | FakeFile> {
    for await (const [, h] of this.entries()) yield h;
  }

  async resolve(descendant: FakeDir | FakeFile): Promise<string[] | null> {
    const path: string[] = [];
    let cur: FakeDir | FakeFile | null = descendant;
    while (cur && cur !== this) {
      path.unshift(cur.name);
      cur = cur instanceof FakeDir ? cur.parent : (cur as unknown as { parent: FakeDir }).parent;
    }
    return cur === this ? path : null;
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  // ---- test helpers -------------------------------------------------------

  mkdir(name: string): FakeDir {
    const d = new FakeDir(name);
    d.parent = this;
    this.children.set(name, d);
    return d;
  }

  put(name: string, size = 3): FakeFile {
    const f = new FakeFile(name, this);
    f.bytes = new Uint8Array(size);
    this.children.set(name, f);
    return f;
  }

  fileNames(): string[] {
    return [...this.children.entries()].filter(([, h]) => h instanceof FakeFile).map(([n]) => n);
  }

  sizeOf(name: string): number {
    const f = this.children.get(name);
    if (!(f instanceof FakeFile)) throw new Error(`no file ${name}`);
    return f.bytes.byteLength;
  }
}

/** Cast helper: the fakes implement the subset of the handle API the core uses. */
export function asDir(d: FakeDir): FileSystemDirectoryHandle {
  return d as unknown as FileSystemDirectoryHandle;
}
