import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

export class ChildPidRegistry {
  private pids = new Set<number>();

  constructor(private filePath: string) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(data)) {
        for (const pid of data) this.pids.add(pid);
      }
    } catch {}
  }

  register(pid: number): void {
    this.pids.add(pid);
    this.save();
  }

  unregister(pid: number): void {
    this.pids.delete(pid);
    this.save();
  }

  list(): number[] {
    return Array.from(this.pids);
  }

  clear(): void {
    this.pids.clear();
    try { unlinkSync(this.filePath); } catch {}
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(Array.from(this.pids)));
  }
}
