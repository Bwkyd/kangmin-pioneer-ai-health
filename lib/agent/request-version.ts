export class RequestVersion {
  #current = 0;

  capture(): number {
    return this.#current;
  }

  invalidate(): void {
    this.#current += 1;
  }

  isCurrent(version: number): boolean {
    return version === this.#current;
  }
}
