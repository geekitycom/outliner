// The cross-instance clipboard captured when copying/cutting selected nodes.
// Mirrors the original module-global `concordClipboard`.

export interface ConcordClipboard {
  text: string
  data: HTMLLIElement[]
}

let current: ConcordClipboard | undefined

export const sharedClipboard = {
  get(): ConcordClipboard | undefined {
    return current
  },
  set(c: ConcordClipboard): void {
    current = c
  },
  clear(): void {
    current = undefined
  },
}
