import type { ContextMenuItem } from '@shared/types'

/**
 * A DOM context menu for runtimes without a native popup that reports
 * dismissal (Tauri). Resolves with the chosen id, or null when dismissed.
 */

let lastPointer = { x: 0, y: 0 }
let tracking = false

function track(): void {
  if (tracking) return
  tracking = true
  const remember = (e: MouseEvent): void => {
    lastPointer = { x: e.clientX, y: e.clientY }
  }
  window.addEventListener('contextmenu', remember, true)
  window.addEventListener('mousedown', remember, true)
}
track()

let closeCurrent: (() => void) | null = null

export function showContextMenu(items: ContextMenuItem[]): Promise<string | null> {
  closeCurrent?.()
  return new Promise((resolve) => {
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    menu.setAttribute('role', 'menu')
    const buttons: HTMLButtonElement[] = []

    const finish = (id: string | null): void => {
      closeCurrent = null
      menu.remove()
      window.removeEventListener('mousedown', onOutside, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      resolve(id)
    }
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) finish(null)
    }
    const onBlur = (): void => finish(null)
    const onKey = (e: KeyboardEvent): void => {
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'Escape') finish(null)
      else if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus()
      else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
      else return
      e.preventDefault()
      e.stopPropagation()
    }

    for (const item of items) {
      if (item.type === 'separator') {
        menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }))
        continue
      }
      const b = document.createElement('button')
      b.className = 'ctx-item'
      b.disabled = item.enabled === false
      b.setAttribute('role', 'menuitem')
      const label = document.createElement('span')
      label.textContent = item.label ?? ''
      b.appendChild(label)
      if (item.accelerator) {
        const k = document.createElement('kbd')
        k.textContent = item.accelerator
        b.appendChild(k)
      }
      b.addEventListener('click', () => finish(item.id ?? null))
      buttons.push(b)
      menu.appendChild(b)
    }

    document.body.appendChild(menu)
    // Keep the menu on screen.
    const { innerWidth: vw, innerHeight: vh } = window
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.min(lastPointer.x, vw - r.width - 6)}px`
    menu.style.top = `${Math.min(lastPointer.y, vh - r.height - 6)}px`

    closeCurrent = () => finish(null)
    setTimeout(() => {
      window.addEventListener('mousedown', onOutside, true)
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('blur', onBlur)
    })
  })
}
