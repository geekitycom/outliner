// Comment handling. Ported from ConcordScript.
import type { Outliner } from './outliner'
import { getNodeAttributes, nodeParents } from './dom'

export class Script {
  constructor(private o: Outliner) {}

  isComment(): boolean {
    const cursor = this.o.op.getCursor()
    if (!cursor) return false
    const own = getNodeAttributes(cursor)['isComment']
    if (own !== undefined) return own === 'true'
    return nodeParents(cursor).some(
      (p) => getNodeAttributes(p)['isComment'] === 'true',
    )
  }

  makeComment(): boolean {
    this.o.op.attributes.setOne('isComment', 'true')
    this.o.op.getCursor()?.classList.add('concord-comment')
    return true
  }

  unComment(): boolean {
    this.o.op.attributes.setOne('isComment', 'false')
    this.o.op.getCursor()?.classList.remove('concord-comment')
    return true
  }

  toggleComment(): void {
    if (this.isComment()) this.unComment()
    else this.makeComment()
  }
}
