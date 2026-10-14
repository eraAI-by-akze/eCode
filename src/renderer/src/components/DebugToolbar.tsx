import { useStore } from '../store'
import * as dbg from '../debugService'
import { formatKeys } from '../commands'
import { IconContinue, IconPause, IconRestart, IconStepInto, IconStepOut, IconStepOver, IconStop } from './Icons'

/** Floating controls over the editor while a debug session runs. */
export function DebugToolbar() {
  const debug = useStore((s) => s.debug)
  if (!debug) return null
  const paused = debug.status === 'paused'
  const k = (keys: string): string => ` (${formatKeys([keys])})`
  return (
    <div className={`debug-toolbar ${debug.status}`} role="toolbar">
      {paused ? (
        <button className="go" title={`Продолжить${k('f5')}`} onClick={() => void dbg.continueExecution()}>
          <IconContinue size={15} />
        </button>
      ) : (
        <button title="Пауза" disabled={debug.status !== 'running'} onClick={() => void dbg.pauseExecution()}>
          <IconPause size={15} />
        </button>
      )}
      <button title={`Шаг с обходом${k('f10')}`} disabled={!paused} onClick={() => void dbg.stepOver()}>
        <IconStepOver size={15} />
      </button>
      <button title={`Шаг с заходом${k('f11')}`} disabled={!paused} onClick={() => void dbg.stepInto()}>
        <IconStepInto size={15} />
      </button>
      <button title={`Шаг с выходом${k('shift+f11')}`} disabled={!paused} onClick={() => void dbg.stepOut()}>
        <IconStepOut size={15} />
      </button>
      <span className="debug-toolbar-sep" />
      <button title={`Перезапустить${k('mod+shift+f5')}`} onClick={() => void dbg.restartDebugging()}>
        <IconRestart size={15} />
      </button>
      <button className="stop" title={`Остановить${k('shift+f5')}`} onClick={() => void dbg.stopDebugging()}>
        <IconStop size={12} />
      </button>
    </div>
  )
}
