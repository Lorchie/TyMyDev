import { useState } from 'react'

/** A desktop shortcut that opens this branch directly — for the tester who follows one. */
export function ShortcutButton({ branchKey }: { branchKey: string }): JSX.Element {
  const [created, setCreated] = useState(false)

  return (
    <button
      className="ghost"
      title="Desktop shortcut that opens this branch directly"
      onClick={async () => {
        await window.trymydev.shortcut(branchKey)
        setCreated(true)
        setTimeout(() => setCreated(false), 2000)
      }}
    >
      {created ? 'Shortcut created' : 'Shortcut'}
    </button>
  )
}
