'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Clock3 } from 'lucide-react'

const options = [
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
]

export default function ExpiryPicker({ value, onChange, disabled }: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = options.findIndex(option => option.value === value)
  const expanded = open && !disabled

  function choose(index: number) {
    onChange(options[index].value)
    setOpen(false)
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      setOpen(false)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && expanded) {
      event.preventDefault()
      choose(highlight)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setOpen(true)
    if (event.key === 'Home') setHighlight(0)
    else if (event.key === 'End') setHighlight(options.length - 1)
    else if (!expanded) setHighlight(selected)
    else setHighlight((highlight + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
  }

  return <div className="expiry-field">
    <label id="expiry-label" htmlFor="expiry">Expires in</label>
    <div className="expiry-picker" data-open={expanded} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button ref={trigger} id="expiry" type="button" className="input expiry-trigger" role="combobox"
        aria-labelledby="expiry-label expiry-value" aria-expanded={expanded} aria-controls="expiry-options"
        aria-activedescendant={expanded ? 'expiry-option-' + highlight : undefined}
        disabled={disabled} onKeyDown={handleKey} onClick={() => {
          setHighlight(selected)
          setOpen(!expanded)
        }}>
        <Clock3 size={17} aria-hidden="true" /><span id="expiry-value">{options[selected].label}</span>
        <ChevronDown className="expiry-chevron" size={16} aria-hidden="true" />
      </button>
      <ul className="expiry-menu" id="expiry-options" role="listbox" aria-labelledby="expiry-label"
        aria-hidden={!expanded} inert={!expanded}>
        {options.map((option, index) => <li key={option.value} id={'expiry-option-' + index} role="option"
          aria-selected={index === selected} data-highlight={index === highlight}
          onPointerMove={() => setHighlight(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => { choose(index); trigger.current?.focus() }}>
          <span>{option.label}</span>{index === selected && <Check size={16} aria-hidden="true" />}
        </li>)}
      </ul>
    </div>
  </div>
}
